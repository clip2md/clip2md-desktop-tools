import { describe, expect, it, vi } from 'vitest';
import { MODEL, agentRepairInstructions, toolPaths } from './tool-setup';
import { prepareManagedTools } from './tool-installer-market';
describe('fixed resource and market discovery', () => {
    it('always chooses the managed model location instead of a user-supplied model', () => {
        expect(toolPaths('/device/Clip2MD').whisperModel).toBe('/device/Clip2MD/ggml-base.bin');
        expect(MODEL.sha256).toHaveLength(64);
        expect(agentRepairInstructions('/device/Clip2MD')).toContain(MODEL.sha256);
        expect(agentRepairInstructions('/device/Clip2MD')).toContain('不修改 Vault');
    });
    it('market preparation never installs or downloads missing dependencies', async () => {
        const controller = new AbortController(); controller.abort();
        await expect(prepareManagedTools('/missing', controller.signal, vi.fn())).rejects.toThrow();
    });
});
