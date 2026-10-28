// Rough parameter count (in billions) from a model id, used to decide whether
// a local model is big enough to be trusted with tools. Reads Ollama tags like
// "qwen3.5:4b-q4_K_M" as well as "llama-3.1-8b-instruct". Unknown -> 0.
export function estimateModelSizeB(modelId: string): number {
  const match = (modelId || "").match(/[-:_/](\d+(?:\.\d+)?)[bB](?![a-zA-Z0-9])/);
  return match ? parseFloat(match[1]) : 0;
}
