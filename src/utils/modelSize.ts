// Rough parameter count (in billions) from a model id, used to decide whether
// a local model is big enough to be trusted with tools. Reads Ollama tags like
// "qwen3.5:4b-q4_K_M", MoE tags like "mixtral:8x7b", and "270m" tags. Unknown -> 0.
export function estimateModelSizeB(modelId: string): number {
  const id = String(modelId || "");
  const moeMatch = id.match(/(?:^|[-:_/\s])(\d+)\s*[xX]\s*(\d+(?:\.\d+)?)[bB](?![a-zA-Z0-9])/);
  if (moeMatch) {
    return parseFloat(moeMatch[1]) * parseFloat(moeMatch[2]);
  }
  const matchB = id.match(/(?:^|[-:_/\s])(\d+(?:\.\d+)?)[bB](?![a-zA-Z0-9])/);
  if (matchB) return parseFloat(matchB[1]);
  const matchM = id.match(/(?:^|[-:_/\s])(\d+(?:\.\d+)?)[mM](?![a-zA-Z0-9])/);
  return matchM ? parseFloat(matchM[1]) / 1000 : 0;
}
