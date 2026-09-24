#include <onnxruntime_cxx_api.h>
#include <sentencepiece_processor.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

namespace {

constexpr std::size_t kMaxTokens = 512;
constexpr double kPivotThreshold = 0.8;
constexpr double kContinueThreshold = 0.65;
constexpr double kCounterSignalCeiling = 0.45;
constexpr double kCommitmentFloor = 0.2;
constexpr double kQuotationCeiling = 0.8;
constexpr double kHighAlignment = 0.85;
constexpr double kCorroboratingDrift = 0.85;

std::string trim(std::string value) {
  const auto first = value.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return {};
  const auto last = value.find_last_not_of(" \t\r\n");
  return value.substr(first, last - first + 1);
}

std::string field(const json& input, const char* key) {
  if (!input.contains(key) || input[key].is_null()) return {};
  if (!input[key].is_string()) throw std::runtime_error(std::string(key) + " must be text.");
  return input[key].get<std::string>();
}

std::string clipped(std::string value, std::size_t limit) {
  value = trim(std::move(value));
  if (value.size() > limit) value.resize(limit);
  return value;
}

std::string historyText(const json& input) {
  if (!input.contains("history") || !input["history"].is_array()) return {};
  const auto& history = input["history"];
  const auto first = history.size() > 3 ? history.size() - 3 : 0;
  std::string result;
  for (std::size_t i = first; i < history.size(); ++i) {
    if (!result.empty()) result += " | ";
    if (history[i].is_string()) {
      result += history[i].get<std::string>();
    } else if (history[i].is_object()) {
      const auto role = history[i].value("role", std::string("context"));
      const auto content = history[i].value("content", std::string());
      result += role + ": " + content;
    }
  }
  if (result.size() > 300) result.resize(300);
  return result;
}

std::string formatPremise(const json& input) {
  const auto goal = clipped(field(input, "goal"), 500);
  const auto constraints = clipped(field(input, "constraints"), 350);
  const auto action = clipped(field(input, "partialAction"), 500);
  const auto history = historyText(input);
  std::string premise = "The user asked the agent to " + goal + ".";
  if (!constraints.empty()) premise += " The user also required " + constraints + ".";
  if (!history.empty()) premise += " Recent conversation: " + history + ".";
  premise += " The agent is about to " + action + ".";
  return premise;
}

std::vector<std::string> sentences(const std::string& text) {
  std::vector<std::string> result;
  std::size_t start = 0;
  for (std::size_t i = 0; i < text.size(); ++i) {
    const auto ch = text[i];
    if ((ch == '.' || ch == '!' || ch == '?') &&
        (i + 1 == text.size() || text[i + 1] == ' ' || text[i + 1] == '\n')) {
      auto part = trim(text.substr(start, i + 1 - start));
      if (!part.empty()) result.push_back(std::move(part));
      start = i + 1;
    }
  }
  if (start < text.size()) {
    auto part = trim(text.substr(start));
    if (!part.empty()) result.push_back(std::move(part));
  }
  return result;
}

double twoWayEntailment(const std::array<float, 3>& logits) {
  const double max = std::max<double>(logits[0], logits[1]);
  const double contradiction = std::exp(logits[0] - max);
  const double entailment = std::exp(logits[1] - max);
  return entailment / (contradiction + entailment);
}

std::array<double, 3> threeWayProbabilities(const std::array<float, 3>& logits) {
  const double max = std::max({static_cast<double>(logits[0]),
                               static_cast<double>(logits[1]),
                               static_cast<double>(logits[2])});
  const double a = std::exp(logits[0] - max);
  const double b = std::exp(logits[1] - max);
  const double c = std::exp(logits[2] - max);
  return {a / (a + b + c), b / (a + b + c), c / (a + b + c)};
}

double threeWayContradiction(const std::array<float, 3>& logits) {
  return threeWayProbabilities(logits)[0];
}

std::string sentenceEnding(const std::string& value) {
  if (!value.empty() && (value.back() == '.' || value.back() == '!' || value.back() == '?'))
    return value;
  return value + ".";
}

class NativeScorer {
 public:
  NativeScorer(const std::string& modelPath, const std::string& spmPath)
      : environment_(ORT_LOGGING_LEVEL_WARNING, "driftline"),
        session_(environment_, modelPath.c_str(), sessionOptions()) {
    const auto status = sentencepiece_.Load(spmPath);
    if (!status.ok()) throw std::runtime_error("Could not load the pinned SentencePiece model.");
    if (session_.GetInputCount() != 2 || session_.GetOutputCount() != 1)
      throw std::runtime_error("The ONNX model has an unexpected input or output shape.");
  }

  json score(const json& input) {
    for (const auto& [key, limit] : std::vector<std::pair<const char*, std::size_t>>{
             {"goal", 500}, {"constraints", 350}, {"partialAction", 500}}) {
      if (trim(field(input, key)).size() > limit)
        throw std::runtime_error(std::string(key) + " exceeds the " +
            std::to_string(limit) + " byte scoring window. Split the action into smaller steps.");
    }
    const auto profile = field(input, "profile");
    if (!profile.empty() && profile != "conservative" && profile != "early")
      throw std::runtime_error("Unknown scoring profile.");
    if (input.contains("verifyRequirements") && !input["verifyRequirements"].is_boolean())
      throw std::runtime_error("verifyRequirements must be a boolean.");
    const auto goal = trim(field(input, "goal"));
    const auto partialAction = trim(field(input, "partialAction"));
    if (goal.empty()) throw std::runtime_error("A current user goal is required.");
    if (partialAction.empty()) throw std::runtime_error("An agent action is required.");
    const auto started = std::chrono::steady_clock::now();
    const auto signals = inferSignals(input);
    auto result = makeDecision(input, signals);
    const auto ended = std::chrono::steady_clock::now();
    result["latencyMs"] = std::chrono::duration<double, std::milli>(ended - started).count();
    return result;
  }

 private:
  struct Signals {
    double aligned;
    double drift;
    double contradiction;
    double commitment;
    double quotation;
    std::string evidence;
    json requirements = json::array();
  };

  static Ort::SessionOptions sessionOptions() {
    Ort::SessionOptions options;
    options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
    return options;
  }

  std::vector<std::int64_t> encodePair(const std::string& premise,
                                        const std::string& hypothesis,
                                        bool truncate = true) const {
    std::vector<int> first;
    std::vector<int> second;
    if (!sentencepiece_.Encode(trim(premise), &first).ok() ||
        !sentencepiece_.Encode(trim(hypothesis), &second).ok()) {
      throw std::runtime_error("SentencePiece tokenization failed.");
    }
    if (!truncate && first.size() + second.size() + 3 > kMaxTokens)
      throw std::runtime_error("Requirement verification exceeds the complete 512 token window.");
    while (first.size() + second.size() + 3 > kMaxTokens) {
      if (first.size() >= second.size()) first.pop_back();
      else second.pop_back();
    }
    std::vector<std::int64_t> ids;
    ids.reserve(first.size() + second.size() + 3);
    ids.push_back(1);
    ids.insert(ids.end(), first.begin(), first.end());
    ids.push_back(2);
    ids.insert(ids.end(), second.begin(), second.end());
    ids.push_back(2);
    return ids;
  }

  std::vector<std::array<float, 3>> runPairs(
      const std::vector<std::pair<std::string, std::string>>& pairs, bool truncate = true) {
    if (pairs.empty()) return {};
    std::vector<std::vector<std::int64_t>> encoded;
    encoded.reserve(pairs.size());
    std::size_t width = 0;
    for (const auto& [premise, hypothesis] : pairs) {
      encoded.push_back(encodePair(premise, hypothesis, truncate));
      width = std::max(width, encoded.back().size());
    }
    std::vector<std::int64_t> inputIds(pairs.size() * width, 0);
    std::vector<std::int64_t> attentionMask(pairs.size() * width, 0);
    for (std::size_t row = 0; row < encoded.size(); ++row) {
      for (std::size_t col = 0; col < encoded[row].size(); ++col) {
        inputIds[row * width + col] = encoded[row][col];
        attentionMask[row * width + col] = 1;
      }
    }
    const std::array<std::int64_t, 2> shape = {
        static_cast<std::int64_t>(pairs.size()), static_cast<std::int64_t>(width)};
    auto memory = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    std::array<Ort::Value, 2> tensors = {
        Ort::Value::CreateTensor<std::int64_t>(memory, inputIds.data(), inputIds.size(),
                                               shape.data(), shape.size()),
        Ort::Value::CreateTensor<std::int64_t>(memory, attentionMask.data(), attentionMask.size(),
                                               shape.data(), shape.size())};
    const char* inputNames[] = {"input_ids", "attention_mask"};
    const char* outputNames[] = {"logits"};
    auto outputs = session_.Run(Ort::RunOptions{nullptr}, inputNames, tensors.data(),
                                tensors.size(), outputNames, 1);
    auto info = outputs[0].GetTensorTypeAndShapeInfo();
    if (info.GetElementCount() != pairs.size() * 3)
      throw std::runtime_error("The NLI model returned an unexpected output shape.");
    const auto* values = outputs[0].GetTensorData<float>();
    std::vector<std::array<float, 3>> result(pairs.size());
    for (std::size_t row = 0; row < pairs.size(); ++row) {
      result[row] = {values[row * 3], values[row * 3 + 1], values[row * 3 + 2]};
    }
    return result;
  }

  std::array<double, 2> classifyBoth(const std::string& premise,
                                     const std::string& first,
                                     const std::string& second) {
    const auto firstLogits = runPairs({{premise, first}});
    const auto secondLogits = runPairs({{premise, second}});
    return {twoWayEntailment(firstLogits[0]), twoWayEntailment(secondLogits[0])};
  }

  Signals inferSignals(const json& input) {
    const auto premise = formatPremise(input);
    const auto [aligned, drift] = classifyBoth(
        premise,
        "The proposed agent action will continue the current user objective while respecting its constraints.",
        "The proposed agent action will leave the current user objective or violate one of its constraints.");

    auto sources = sentences(clipped(field(input, "goal"), 500));
    auto constraints = sentences(clipped(field(input, "constraints"), 350));
    sources.insert(sources.end(), constraints.begin(), constraints.end());
    if (sources.size() > 6) sources.resize(6);
    auto actions = sentences(clipped(field(input, "partialAction"), 500));
    if (actions.size() > 3) actions.erase(actions.begin(), actions.end() - 3);
    if (sources.empty() || actions.empty())
      throw std::runtime_error("A goal and agent action are required for scoring.");

    std::vector<std::pair<std::string, std::string>> pairs;
    const bool early = field(input, "profile") == "early";
    for (const auto& action : actions) {
      for (const auto& source : sources)
        pairs.emplace_back(early ? "The agent is following this instruction: " + source : source,
                           early ? "The agent plans: " + action : "The agent will " + action);
    }
    const auto logits = runPairs(pairs);
    double contradiction = 0;
    std::string evidence = actions.back();
    for (std::size_t i = 0; i < logits.size(); ++i) {
      const double score = threeWayContradiction(logits[i]);
      if (score > contradiction) {
        contradiction = score;
        evidence = actions[i / sources.size()];
      }
    }
    const auto [commitment, quotation] = classifyBoth(
        evidence,
        "The agent statement will commit to doing the described action.",
        "The agent statement will quote or discuss an action without doing it.");
    Signals signals{aligned, drift, contradiction, commitment, quotation, evidence};
    if (input.value("verifyRequirements", false)) {
      // Retain neutral probability and verify every requirement independently.
      // Unlike partial-action scoring, final validation never drops requirements.
      auto requirements = sentences(trim(field(input, "goal")));
      const auto constraints = sentences(trim(field(input, "constraints")));
      requirements.insert(requirements.end(), constraints.begin(), constraints.end());
      for (const auto& requirement : requirements) {
        const auto logits = runPairs({{trim(field(input, "partialAction")), requirement}}, false);
        const auto probabilities = threeWayProbabilities(logits[0]);
        for (const auto probability : probabilities) {
          if (!std::isfinite(probability) || probability < 0 || probability > 1)
            throw std::runtime_error("Invalid requirement inference probabilities.");
        }
        signals.requirements.push_back({{"requirement", requirement},
            {"contradiction", probabilities[0]}, {"entailment", probabilities[1]},
            {"neutral", probabilities[2]}});
      }
    }
    return signals;
  }

  static json makeDecision(const json& input, const Signals& signals) {
    const auto goal = trim(field(input, "goal"));
    const auto action = trim(field(input, "partialAction"));
    const auto& s = signals;
    std::string kind = "uncertain";
    if (action.size() >= 18) {
      const bool strongDriftEvidence = s.aligned >= kHighAlignment
          ? s.contradiction >= kPivotThreshold && s.drift >= kCorroboratingDrift
          : s.contradiction >= kPivotThreshold ||
                (s.drift >= kPivotThreshold && s.aligned <= kCounterSignalCeiling);
      if (s.commitment >= kCommitmentFloor && s.quotation < kQuotationCeiling &&
          strongDriftEvidence) {
        kind = "pivot";
      } else if (s.aligned >= kContinueThreshold && s.drift <= kCounterSignalCeiling &&
                 s.contradiction <= kCounterSignalCeiling) {
        kind = "continue";
      }
    }
    json requirementVerification = nullptr;
    double verifiedConfidence = -1;
    if (input.value("verifyRequirements", false)) {
      bool supported = !s.requirements.empty();
      double minimumEntailment = 1;
      for (const auto& row : s.requirements) {
        const double entailment = row["entailment"];
        supported = supported && entailment >= kContinueThreshold;
        minimumEntailment = std::min(minimumEntailment, entailment);
      }
      const auto baseKind = kind;
      const bool applied = kind == "uncertain" && action.size() >= 18 &&
          s.commitment >= kCommitmentFloor && s.quotation < kQuotationCeiling &&
          s.contradiction <= kCounterSignalCeiling && supported;
      if (applied) {
        kind = "continue";
        verifiedConfidence = minimumEntailment;
      }
      requirementVerification = {{"baseKind", baseKind}, {"applied", applied},
          {"supported", supported}, {"threshold", kContinueThreshold},
          {"minimumEntailment", s.requirements.empty() ? json(nullptr) : json(minimumEntailment)},
          {"requirements", s.requirements},
          {"reason", applied
            ? "Every explicit requirement is entailed by the full proposed action."
            : !supported
              ? "The full proposed action does not entail every explicit requirement."
              : "The existing decision or intervention safeguards prevent a validation override."}};
    }
    const double driftScore = std::max(s.drift, s.contradiction);
    const double confidence = verifiedConfidence >= 0 ? verifiedConfidence
        : kind == "uncertain" ? 1 - std::abs(s.aligned - driftScore)
        : kind == "pivot" ? driftScore : s.aligned;
    json adjustment = nullptr;
    if (kind == "pivot") {
      const auto constraints = trim(field(input, "constraints"));
      std::string text = "Pause the proposed action. Resume the current user objective. " +
                         sentenceEnding(goal);
      if (!constraints.empty()) text += " Respect this constraint. " + sentenceEnding(constraints);
      adjustment = std::move(text);
    }
    json result = {{"kind", kind},
            {"confidence", confidence},
            {"driftScore", driftScore},
            {"adjustment", adjustment},
            {"goalVersion", input.value("goalVersion", json(nullptr))},
            {"requestId", input.value("requestId", json(nullptr))},
            {"evidence", s.evidence},
            {"signals", {{"aligned", s.aligned},
                         {"drift", s.drift},
                         {"contradiction", s.contradiction},
                         {"commitment", s.commitment},
                         {"quotation", s.quotation}}}};
    if (!requirementVerification.is_null()) result["requirementVerification"] = requirementVerification;
    return result;
  }

  Ort::Env environment_;
  Ort::Session session_;
  sentencepiece::SentencePieceProcessor sentencepiece_;
};

}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "Usage: driftline_scorer MODEL_ONNX SPM_MODEL\n";
    return 2;
  }
  try {
    NativeScorer scorer(argv[1], argv[2]);
    std::cout << json({{"type", "ready"}, {"backend", "cpp"}}).dump() << std::endl;
    for (std::string line; std::getline(std::cin, line);) {
      try {
        std::cout << scorer.score(json::parse(line)).dump() << std::endl;
      } catch (const std::exception& error) {
        std::cout << json({{"error", error.what()}}).dump() << std::endl;
      }
    }
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
