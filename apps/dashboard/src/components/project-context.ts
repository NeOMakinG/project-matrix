import { useParams } from "@tanstack/react-router";

const STORAGE_KEY = "matrix.lastProject";
export const DEFAULT_PROJECT = "ledgerly";

export function rememberProject(projectId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, projectId);
  } catch {
    // storage unavailable (private mode, tests): the default project is fine
  }
}

function lastProject(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_PROJECT;
  } catch {
    return DEFAULT_PROJECT;
  }
}

export function useCurrentProjectId(): string {
  const params = useParams({ strict: false }) as { projectId?: string };
  return params.projectId ?? lastProject();
}
