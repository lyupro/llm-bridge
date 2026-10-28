/**
 * Names where an installation puts package files under a Claude root — one spelling for the
 * installer and the hooks, Plan_67 D10.
 */
import path from 'node:path';
import { PACKAGE_NAME } from './package-identity.mjs';

export function claudePaths(root) {
  return {
    agentsDir: path.join(root, 'agents', PACKAGE_NAME),
    commandsDir: path.join(root, 'commands', PACKAGE_NAME),
    rulesDir: path.join(root, 'rules', PACKAGE_NAME),
  };
}
