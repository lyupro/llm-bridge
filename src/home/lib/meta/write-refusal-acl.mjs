/** Measures Windows folder ACLs after a build reports a scope write refusal. */
import { parseJsonText } from '../json-file.mjs';
import { spawnCaptured } from '../runner/codex-cmd.mjs';

// OW-092 D3 needs comparable ACLs for the root and every refused folder within one deadline.
// Keeping paths in the child's environment preserves literal names without interpolating code.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Measure-Folder([string]$folderPath) {
    try {
        $item = Get-Item -LiteralPath $folderPath -Force
    } catch [System.Management.Automation.ItemNotFoundException] {
        return @{ path = $folderPath; exists = $false; isReparsePoint = $false; ownerSid = $null; rules = @() }
    } catch {
        return @{ path = $folderPath; error = 'Get-Item failed' }
    }

    try {
        $acl = Get-Acl -LiteralPath $folderPath
        $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
        if (-not $ownerSid) {
            return @{ path = $folderPath; error = 'ACL owner SID unavailable' }
        }
        $rules = @(
            foreach ($rule in $acl.Access) {
                $sid = $rule.IdentityReference.Value
                try {
                    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
                } catch {
                    # OW-092 D3 still needs the rule when its identity has no SID mapping.
                }
                @{
                    sid = $sid
                    rights = $rule.FileSystemRights.ToString()
                    type = $rule.AccessControlType.ToString()
                    inherited = $rule.IsInherited
                    containerInherit = [bool]($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ContainerInherit)
                    objectInherit = [bool]($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit)
                }
            }
        )
        return @{
            path = $folderPath
            exists = $true
            isReparsePoint = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
            ownerSid = $ownerSid
            rules = $rules
        }
    } catch {
        return @{ path = $folderPath; error = 'Get-Acl failed' }
    }
}

$request = ConvertFrom-Json -InputObject $env:LLM_BRIDGE_ACL_PATHS
$sandboxSid = $null
try {
    $account = [System.Security.Principal.NTAccount]::new($env:COMPUTERNAME, 'CodexSandboxOffline')
    $sandboxSid = $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
} catch [System.Security.Principal.IdentityNotMappedException] {
    # The local account may not have been created on this host.
}

$root = Measure-Folder $request.repoRoot
# The machine-wide SID belongs with the root so it is recorded only once.
$root.sandboxSid = $sandboxSid
$result = @{
    root = $root
    folders = @(foreach ($folderPath in $request.folders) { Measure-Folder $folderPath })
}
[Console]::WriteLine(($result | ConvertTo-Json -Depth 6 -Compress))
`;
const ENCODED_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64');
const MAX_FOLDERS = 20;

function hasKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

function isSid(value) {
  return typeof value === 'string' && /^S-\d+(?:-\d+)+$/.test(value);
}

function isRule(rule) {
  return hasKeys(rule, ['sid', 'rights', 'type', 'inherited', 'containerInherit', 'objectInherit']) &&
    isText(rule.sid) && isText(rule.rights) && (rule.type === 'Allow' || rule.type === 'Deny') &&
    typeof rule.inherited === 'boolean' && typeof rule.containerInherit === 'boolean' &&
    typeof rule.objectInherit === 'boolean';
}

function isFolder(folder, expectedPath, extraKeys = []) {
  if (folder?.path !== expectedPath) return false;
  if (hasKeys(folder, ['path', 'error', ...extraKeys])) return isText(folder.error);
  if (!hasKeys(folder, ['path', 'exists', 'isReparsePoint', 'ownerSid', 'rules', ...extraKeys]) ||
      !Array.isArray(folder.rules)) return false;
  if (folder.exists === false) {
    return folder.isReparsePoint === false && folder.ownerSid === null && folder.rules.length === 0;
  }
  return folder.exists === true && typeof folder.isReparsePoint === 'boolean' &&
    isSid(folder.ownerSid) && folder.rules.every(isRule);
}

function notMeasured(reason) {
  return { status: 'not-measured', reason };
}

function captureFailure(error) {
  return notMeasured(error?.code === 'ETIMEDOUT' ? 'timeout' : 'spawn-error');
}

export async function measureFolderAcls({
  repoRoot, folders, timeoutMs = 5000, platform = process.platform, capture = spawnCaptured,
}) {
  if (platform !== 'win32') return notMeasured('not-windows');
  if (folders.length > MAX_FOLDERS) return notMeasured('too-many-folders');

  // Keep the expected paths stable while the child runs, including duplicates and input order.
  const requestedFolders = [...folders];
  let result;
  try {
    result = await capture('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED_SCRIPT,
    ], {
      windowsHide: true,
      timeout: timeoutMs,
      env: { ...process.env, LLM_BRIDGE_ACL_PATHS: JSON.stringify({ repoRoot, folders: requestedFolders }) },
    });
  } catch (error) {
    return captureFailure(error);
  }
  if (result?.error) return captureFailure(result.error);
  if (!result || !Number.isInteger(result.status)) return notMeasured('spawn-error');
  if (result.status !== 0) return notMeasured(`exit-${result.status}`);

  let output;
  try {
    if (typeof result.stdout !== 'string') return notMeasured('malformed-output');
    output = parseJsonText('PowerShell ACL output', result.stdout);
  } catch {
    return notMeasured('malformed-output');
  }
  if (!hasKeys(output, ['root', 'folders']) ||
      !isFolder(output.root, repoRoot, ['sandboxSid']) ||
      !(output.root.sandboxSid === null || isSid(output.root.sandboxSid)) ||
      !Array.isArray(output.folders) || output.folders.length !== requestedFolders.length ||
      !output.folders.every((folder, index) => isFolder(folder, requestedFolders[index]))) {
    return notMeasured('malformed-output');
  }
  return { status: 'measured', root: output.root, folders: output.folders };
}
