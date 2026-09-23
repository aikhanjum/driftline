cmake_minimum_required(VERSION 3.20)
project(driftline_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(onnxruntime 1.21.0 EXACT CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_path(SENTENCEPIECE_INCLUDE_DIR sentencepiece_processor.h REQUIRED)
find_library(SENTENCEPIECE_LIBRARY sentencepiece REQUIRED)
find_library(ABSL_STATUS_LIBRARY absl_status REQUIRED)

add_executable(driftline_scorer scorer.cpp)
target_include_directories(driftline_scorer PRIVATE ${SENTENCEPIECE_INCLUDE_DIR})
target_link_libraries(driftline_scorer PRIVATE
  onnxruntime::onnxruntime
  nlohmann_json::nlohmann_json
  ${SENTENCEPIECE_LIBRARY}
  ${ABSL_STATUS_LIBRARY}
)
target_compile_options(driftline_scorer PRIVATE -Wall -Wextra -Wpedantic -Wno-deprecated-declarations)
