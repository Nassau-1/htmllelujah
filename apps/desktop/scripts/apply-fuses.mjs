import path from 'node:path';

import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';

/** @param {{ appOutDir: string, packager: { appInfo: { productFilename: string } } }} context */
export default async function applyReleaseFuses(context) {
  const executable = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  );
  await flipFuses(executable, {
    version: FuseVersion.V1,
    // Required only by the bundled HTMLlelujah-MCP.cmd console launcher. The MCP entrypoint
    // exposes typed tools over authenticated local RPC and no arbitrary eval/path surface.
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
}
