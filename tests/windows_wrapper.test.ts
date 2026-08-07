import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const wrapper = readFileSync(new URL('../packaging/windows/wokey-node.ps1', import.meta.url), 'utf8');

describe('Windows wrapper uninstall', () => {
  it('provides the same uninstall and purge interface as other native platforms', () => {
    expect(wrapper).toContain('"uninstall" { Uninstall-Node }');
    expect(wrapper).toContain('Usage: wokey-node uninstall [--purge]');
    expect(wrapper).toContain('Remove-Service');
    expect(wrapper).toContain('Remove-UserPath $BinDir');
    expect(wrapper).toContain('Start-UninstallCleanup $purgeData');
  });

  it('defers runtime removal until the active wrapper exits', () => {
    expect(wrapper).toContain('Wait-Process -Id $parentPid');
    expect(wrapper).toContain('Start-Sleep -Milliseconds 750');
    expect(wrapper).toContain('Remove-Item -LiteralPath `$path -Recurse -Force');
  });
});
