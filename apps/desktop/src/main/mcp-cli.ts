import path from 'node:path';

import { runHtmllelujahMcpStdioFromDescriptor } from '@htmllelujah/mcp-server';

const defaultUserDataDirectory = (): string => {
  const roamingAppData = process.env.APPDATA;
  if (roamingAppData === undefined || !path.isAbsolute(roamingAppData)) {
    throw new Error('HTMLlelujah user data is unavailable.');
  }
  return path.join(roamingAppData, 'HTMLlelujah');
};

const configuredUserData = process.env.HTMLLELUJAH_USER_DATA_DIR;
const userDataDirectory =
  configuredUserData !== undefined && path.isAbsolute(configuredUserData)
    ? configuredUserData
    : defaultUserDataDirectory();

try {
  await runHtmllelujahMcpStdioFromDescriptor(
    path.join(userDataDirectory, 'mcp', 'endpoint-v1.json'),
  );
} catch {
  process.stderr.write('HTMLlelujah desktop bridge is unavailable.\n');
  process.exitCode = 1;
}
