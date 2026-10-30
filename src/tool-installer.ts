import { discoverTools, type SetupProgress, type ToolPaths } from './tool-setup';
/** Community builds only discover dependencies installed by the user. */
export function prepareManagedTools(root: string, signal: AbortSignal, progress: SetupProgress): Promise<ToolPaths> {
    return discoverTools(root, signal, progress);
}
