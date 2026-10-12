import { type MatrixConfig, type MatrixConfigInput, matrixConfig } from "./schema";

export * from "./schema";

export const name = "@matrix/config";

export function defineConfig(config: MatrixConfigInput): MatrixConfigInput {
  return config;
}

export function parseConfig(input: unknown): MatrixConfig {
  return matrixConfig.parse(input);
}
