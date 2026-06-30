#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const baseUrl = (process.env.PROVIDER_NODE_CLI_BASE_URL || 'http://127.0.0.1:16888').replace(/\/$/, '');
const [, , command = 'help', ...args] = process.argv;
let csrfToken = '';
const localeText = [
  process.env.WOKEY_NODE_LANG,
  process.env.WOKEY_LANG,
  process.env.LC_ALL,
  process.env.LANG,
].filter(Boolean).join(' ').toLowerCase();
let activeZh = /\bzh|chinese|中文/.test(localeText);
const useColor = output.isTTY && !process.env.NO_COLOR;
const colors = {
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[0;33m',
  label: '\x1b[1;37m',
  bold: '\x1b[1m',
  plain: '\x1b[0m',
};
const zhText = {
  err: '错误',
  menuTitle: 'Wokey 节点管理',
  optionBind: '粘贴绑定码并绑定当前节点',
  optionBindingHelp: '查看如何获取绑定码',
  optionList: '查看检测到的本机授权',
  optionStatus: '查看节点状态',
  optionScanImport: '扫描本机授权并导入',
  optionPasteManual: '手动粘贴授权',
  optionExit: '退出',
  chooseOption: '请选择操作：',
  invalidSelection: '无效选择。',
  noLocalCandidates: '没有发现本机授权候选项。',
  addNeedsInteractive: 'wokey-node 需要交互式终端。脚本模式请使用 help 查看直接命令。',
  addAfterBoundNeedsInteractive: '节点绑定后，wokey-node add 需要交互式终端。脚本模式请使用 list/import/login/paste。',
  nodeNotBoundScript: '节点尚未绑定。请运行 wokey-node bind --value bind_...，或在交互式终端运行 wokey-node。',
  bindPrompt: '请粘贴 bind_ 开头的绑定码，完成后按 Ctrl-D：',
  bindCodeQuestion: '\n粘贴绑定码（bind_...）：',
  bindCodeRequired: '缺少绑定码。',
  nodeBoundSuccess: '节点绑定成功',
  toProvider: '，Provider：',
  detectedLocalCredentials: '检测到本机授权：',
  noImportableLocalCredentials: '没有可导入的本机授权。',
  importDetectedLocalCredential: '导入检测到的本机授权',
  pasteAuthorizationManually: '手动粘贴授权',
  chooseAction: '请选择授权方式：',
  pasteManualTitle: '手动粘贴授权：',
  pasteCodexTokenJson: '粘贴 Codex auth.json 或 OAuth Token JSON',
  pasteClaudeTokenJson: '粘贴 Claude OAuth Token JSON',
  back: '返回',
  importWhich: '导入第几个候选项？',
  oauthPrompt: '请粘贴 OAuth token JSON 或 Codex auth.json，完成后按 Ctrl-D：',
  oauthInlinePrompt: 'OAuth token JSON 或 Codex auth.json：',
  oauthMultilineContinue: '继续粘贴 JSON，粘贴完成后单独按 Enter 空行提交：',
  oauthJsonInvalid: 'OAuth JSON 格式不完整或无法解析。',
  oauthAccessTokenRequired: '缺少 OAuth access token。',
  oauthRefreshTokenRequired: 'OpenAI/Codex 授权必须包含 refresh token。请粘贴完整 Codex auth.json 或完整 OAuth token JSON。',
  claudeOAuthChallenge: 'Claude 浏览器 OAuth 安全挑战不能作为节点授权使用。请改用 Claude Code 本机授权或 Claude OAuth 授权。',
  claudeOAuthChallengeFailed: 'Claude 浏览器 OAuth 安全挑战不能作为节点授权使用。请改用 Claude Code 本机授权或 Claude OAuth 授权。',
  codexOpen: '打开：',
  code: '验证码：',
  waitingAuthorization: '等待授权完成...',
  noImportableCandidates: '没有可导入的本机授权候选项。',
  version: '版本：',
  nodeId: '节点 ID：',
  bound: '已绑定：',
  yes: '是',
  no: '否',
  platformBindUrl: 'Platform 绑定地址：',
  providerId: 'Provider ID：',
  bridge: '桥接状态：',
  serverBinding: '平台绑定校验：',
  platformNodeStatus: '平台节点状态：',
  localConsole: '本地控制台：',
  nextStep: '下一步：',
  nextAddCredential: '运行 wokey-node add 添加授权。',
  nextBindNode: '运行 wokey-node 绑定节点。',
  platformUnavailable: '不可用',
  connected: '已连接',
  disconnected: '未连接',
  verified: '正常',
  importableLocalCredentials: '可导入本机授权：',
  authorizedNodeCredentials: '节点已授权：',
  authorizedCredentialDetails: '已授权明细：',
  noAuthorizedNodeCredentials: '没有有效的节点授权。',
  credentialIdLabel: '授权ID',
  statusLabel: '状态',
  statusTitle: '节点状态',
  bindTitle: '绑定当前节点',
  notBoundYet: '当前节点尚未绑定。添加授权前需要先绑定节点。',
  getBindingCode: '获取绑定码：',
  bindStep1: '1. 在你自己的电脑上打开 Wokey Provider 页面。',
  bindStep2: '2. 生成节点绑定码。',
  bindStep3: '3. 复制 bind_ 开头的绑定码。',
  tunnelHelp: '如果你想使用本地网页控制台，请先打开 SSH 隧道：',
  cliBindingCommand: '命令行绑定方式：',
  pressEnter: '按 Enter 返回主菜单...',
  importable: '可导入',
  unavailable: '不可用',
  pathLabel: '路径',
  reasonLabel: '原因',
  authorized: '已授权',
  credential: '授权',
  consoleUnreachable: 'Provider Node 本地控制台无法访问',
  startWithRestart: '请先运行：wokey-node restart',
  fileRequiresPath: '--file 需要一个路径。',
  valueRequiresValue: '--value 需要一个值。',
  vendorRequired: '厂商必须是 openai 或 anthropic。',
  usage: `用法：
  wokey-node
  wokey-node add
  wokey-node bind --value bind_...
  wokey-node list
  wokey-node import [候选编号]
  wokey-node login codex
  wokey-node paste token --vendor <openai|anthropic> [--file 路径|--value token]

服务命令：
  wokey-node restart
  wokey-node update
  wokey-node status
  wokey-node logs
  wokey-node doctor

说明：
  - 请在运行 Provider Node 的同一个服务器用户下执行这些命令。
  - 添加授权前，节点必须已经绑定。
  - 本地控制台必须正在运行：wokey-node restart`,
};
const enText = {
  err: 'ERR',
  menuTitle: 'Wokey Node Management',
  optionBind: 'Paste binding code and bind this node',
  optionBindingHelp: 'Show how to get a binding code',
  optionList: 'List detected local credentials',
  optionStatus: 'Show node status',
  optionScanImport: 'Scan local auth and import',
  optionPasteManual: 'Paste authorization manually',
  optionExit: 'Exit',
  chooseOption: 'Choose an option: ',
  invalidSelection: 'Invalid selection.',
  noLocalCandidates: 'No local credential candidates found.',
  addNeedsInteractive: 'wokey-node requires an interactive terminal. Use help to list direct commands.',
  addAfterBoundNeedsInteractive: 'wokey-node add requires an interactive terminal after the node is bound. Use list/import/login/paste for non-interactive scripts.',
  nodeNotBoundScript: 'Node is not bound. Run wokey-node bind --value bind_... or run wokey-node in an interactive terminal.',
  bindPrompt: 'Paste binding code starting with bind_, then press Ctrl-D:',
  bindCodeQuestion: '\nPaste binding code (bind_...): ',
  bindCodeRequired: 'Binding code is required.',
  nodeBoundSuccess: 'Node bound successfully',
  toProvider: ' to provider ',
  detectedLocalCredentials: 'Detected local credentials:',
  noImportableLocalCredentials: 'No importable local credentials were found.',
  importDetectedLocalCredential: 'Import detected local credential',
  pasteAuthorizationManually: 'Paste authorization manually',
  chooseAction: 'Choose an action:',
  pasteManualTitle: 'Paste authorization manually:',
  pasteCodexTokenJson: 'Paste Codex auth.json or OAuth token JSON',
  pasteClaudeTokenJson: 'Paste Claude OAuth token JSON',
  back: 'Back',
  importWhich: 'Import which candidate number? ',
  oauthPrompt: 'Paste OAuth token JSON or Codex auth.json, then press Ctrl-D:',
  oauthInlinePrompt: 'OAuth token JSON or Codex auth.json: ',
  oauthMultilineContinue: 'Continue pasting JSON, then submit with an empty line:',
  oauthJsonInvalid: 'OAuth JSON is incomplete or invalid.',
  oauthAccessTokenRequired: 'OAuth access token is required.',
  oauthRefreshTokenRequired: 'OpenAI/Codex authorization must include a refresh token. Paste a complete Codex auth.json or OAuth token JSON.',
  claudeOAuthChallenge: 'Claude browser OAuth challenges cannot be used as node credentials. Use Claude Code local authorization or Claude OAuth authorization instead.',
  claudeOAuthChallengeFailed: 'Claude browser OAuth challenges cannot be used as node credentials. Use Claude Code local authorization or Claude OAuth authorization instead.',
  codexOpen: 'Open:',
  code: 'Code:',
  waitingAuthorization: 'Waiting for authorization...',
  noImportableCandidates: 'No importable local credential candidates found.',
  version: 'Version:',
  nodeId: 'Node ID:',
  bound: 'Bound:',
  yes: 'yes',
  no: 'no',
  platformBindUrl: 'Platform bind URL:',
  providerId: 'Provider ID:',
  bridge: 'Bridge:',
  serverBinding: 'Platform binding check:',
  platformNodeStatus: 'Platform node status:',
  localConsole: 'Local console:',
  nextStep: 'Next step:',
  nextAddCredential: 'Run wokey-node add to add a credential.',
  nextBindNode: 'Run wokey-node to bind this node.',
  platformUnavailable: 'unavailable',
  connected: 'connected',
  disconnected: 'disconnected',
  verified: 'ok',
  importableLocalCredentials: 'Importable local credentials:',
  authorizedNodeCredentials: 'Authorized node credentials:',
  authorizedCredentialDetails: 'Authorized credential details:',
  noAuthorizedNodeCredentials: 'No active node credentials.',
  credentialIdLabel: 'Credential ID',
  statusLabel: 'status',
  statusTitle: 'Node Status',
  bindTitle: 'Bind This Node',
  notBoundYet: 'This node is not bound yet. Bind it before adding credentials.',
  getBindingCode: 'Get a binding code:',
  bindStep1: '1. Open Wokey Provider page on your own computer.',
  bindStep2: '2. Generate a node binding code.',
  bindStep3: '3. Copy the code that starts with bind_.',
  tunnelHelp: 'If you want to use the local web console instead, open an SSH tunnel:',
  cliBindingCommand: 'CLI binding command:',
  pressEnter: 'Press Enter to return to the main menu...',
  importable: 'importable',
  unavailable: 'unavailable',
  pathLabel: 'path',
  reasonLabel: 'reason',
  authorized: 'Authorized',
  credential: 'credential',
  consoleUnreachable: 'Provider Node console is not reachable',
  startWithRestart: 'Start it with: wokey-node restart',
  fileRequiresPath: '--file requires a path.',
  valueRequiresValue: '--value requires a value.',
  vendorRequired: 'Vendor must be openai or anthropic.',
  usage: `Usage:
  wokey-node
  wokey-node add
  wokey-node bind --value bind_...
  wokey-node list
  wokey-node import [candidate-number]
  wokey-node login codex
  wokey-node paste token --vendor <openai|anthropic> [--file path|--value token]

Service commands:
  wokey-node restart
  wokey-node update
  wokey-node status
  wokey-node logs
  wokey-node doctor

Notes:
  - Run these commands on the same server/user that runs Provider Node.
  - The node must already be bound before credentials can be authorized.
  - The local console must be running: wokey-node restart`,
};
let text = activeZh ? zhText : enText;

try {
  await run(command, args);
} catch (error) {
  console.error(red(`[${text.err}] ${formatCliError(error)}`));
  process.exitCode = 1;
}

async function run(command, args) {
  if (args.includes('--help') || args.includes('-h')) usage();
  if (command === 'help' || command === '--help' || command === '-h') usage();
  if (command === 'menu') return menuCommand();
  if (command === 'list' || command === 'scan') return listCommand();
  if (command === 'add') return addCommand();
  if (command === 'bind') return bindCommand(args);
  if (command === 'import' || command === 'authorize') return importCommand(args);
  if (command === 'login') return loginCommand(args);
  if (command === 'paste') return pasteCommand(args);
  if (command === 'api-status') return apiStatusCommand();
  usage();
}

async function menuCommand() {
  if (!input.isTTY) {
    throw new Error(text.addNeedsInteractive);
  }
  const rl = createInterface({ input, output });
  try {
    await chooseLanguageIfNeeded(rl);
    while (true) {
      const status = await apiStatusCommand({ compact: true, returnStatus: true });
      const isBound = Boolean(status.binding?.isBound);
      const options = isBound
        ? [
            { key: '1', label: text.optionScanImport, action: () => guidedAdd(status, rl) },
            { key: '2', label: text.optionPasteManual, action: () => pasteCredentialMenu(rl) },
            { key: '3', label: text.optionStatus, action: () => apiStatusCommand() },
          ]
        : [
            { key: '1', label: text.optionBind, action: () => bindInteractive(rl) },
            { key: '2', label: text.optionBindingHelp, action: () => printBindingInstructions(status) },
            { key: '3', label: text.optionList, action: () => listCommand() },
            { key: '4', label: text.optionStatus, action: () => apiStatusCommand() },
          ];
      printHeader(text.menuTitle);
      options.forEach((item) => console.log(`${green(`${item.key}.`)} ${item.label}`));
      console.log(`${green('0.')} ${text.optionExit}`);
      const answer = (await rl.question(yellow(text.chooseOption))).trim();
      console.log('');

      if (answer === '0' || answer.toLowerCase() === 'q') return;
      const selected = options.find((item) => item.key === answer);
      if (!selected) {
        console.log(text.invalidSelection);
      } else {
        await selected.action();
      }
      await pause(rl);
    }
  } finally {
    rl.close();
  }
}

async function chooseLanguageIfNeeded(rl) {
  if (activeZh) return;
  console.log('');
  console.log(blue('========================================'));
  console.log(`${blue('  ')}${bold('选择语言 / Choose Language')}`);
  console.log(blue('========================================'));
  console.log(`${green('1.')} 中文`);
  console.log(`${green('2.')} English`);
  const answer = (await rl.question(yellow('请选择语言 / Choose language [1]: '))).trim();
  activeZh = answer !== '2';
  text = activeZh ? zhText : enText;
  console.log('');
}

async function listCommand() {
  const candidates = await detectCandidates();
  if (!candidates.length) {
    console.log(text.noLocalCandidates);
    return;
  }
  printCandidates(candidates);
}

async function addCommand() {
  const status = await apiStatusCommand({ compact: true, returnStatus: true });
  if (!status.binding?.isBound) {
    if (!input.isTTY) {
      throw new Error(text.nodeNotBoundScript);
    }
    const rl = createInterface({ input, output });
    try {
      await bindInteractive(rl);
      const nextStatus = await apiStatusCommand({ compact: true, returnStatus: true });
      if (nextStatus.binding?.isBound) await guidedAdd(nextStatus, rl);
    } finally {
      rl.close();
    }
    return;
  }
  if (!input.isTTY) {
    throw new Error(text.addAfterBoundNeedsInteractive);
  }

  const rl = createInterface({ input, output });
  try {
    await guidedAdd(status, rl);
  } finally {
    rl.close();
  }
}

async function bindCommand(args) {
  const raw = await readPayload(args, text.bindPrompt);
  await bindWithCode(raw);
}

async function bindInteractive(rl) {
  printBindingInstructions(await api('/api/status'));
  const bindingCode = await rl.question(yellow(text.bindCodeQuestion));
  await bindWithCode(bindingCode);
}

async function bindWithCode(raw) {
  const bindingCode = String(raw || '').trim();
  if (!bindingCode) throw new Error(text.bindCodeRequired);
  const result = await api('/api/platform/bind', {
    method: 'POST',
    body: { bindingCode },
  });
  const config = result.config || {};
  console.log(green(`${text.nodeBoundSuccess}${config.providerId ? `${text.toProvider}${config.providerId}` : ''}.`));
}

async function guidedAdd(status, rl) {
  if (!status.binding?.isBound) {
    printBindingInstructions(status);
    return;
  }

  const candidates = await detectCandidates();
  const importable = candidates.filter((item) => item.canImport);
  if (importable.length) {
    console.log(`\n${blue(text.detectedLocalCredentials)}`);
    printCandidates(importable);
  } else {
    console.log(`\n${yellow(text.noImportableLocalCredentials)}`);
  }

  const options = [];
  if (importable.length) {
    options.push({ key: '1', label: text.importDetectedLocalCredential, action: () => chooseAndImport(importable, rl) });
  }
  options.push({ key: String(options.length + 1), label: text.pasteAuthorizationManually, action: () => pasteCredentialMenu(rl) });

  console.log(`\n${blue(text.chooseAction)}`);
  options.forEach((item) => console.log(`${green(`${item.key}.`)} ${item.label}`));
  const answer = (await rl.question(yellow(text.chooseOption))).trim();
  const selected = options.find((item) => item.key === answer);
  if (!selected) throw new Error(text.invalidSelection);
  await selected.action();
}

async function pasteCredentialMenu(rl) {
  console.log(`\n${blue(text.pasteManualTitle)}`);
  const options = [
    { key: '1', label: text.pasteCodexTokenJson, action: () => pasteTokenInteractive(rl, 'openai') },
    { key: '2', label: text.pasteClaudeTokenJson, action: () => pasteTokenInteractive(rl, 'anthropic') },
  ];
  options.forEach((item) => console.log(`${green(`${item.key}.`)} ${item.label}`));
  console.log(`${green('0.')} ${text.back}`);
  const answer = (await rl.question(yellow(text.chooseOption))).trim();
  if (answer === '0' || answer.toLowerCase() === 'q') return;
  const selected = options.find((item) => item.key === answer);
  if (!selected) throw new Error(text.invalidSelection);
  await selected.action();
}

async function importCommand(args) {
  const candidates = await detectCandidates();
  const importable = candidates.filter((item) => item.canImport);
  if (!importable.length) throw new Error(text.noImportableCandidates);
  const selected = await selectCandidate(importable, args[0]);
  await importCandidate(selected);
}

async function loginCommand(args) {
  const provider = args[0];
  if (provider === 'codex' || provider === 'openai') return codexDeviceCommand();
  throw new Error('Usage: wokey-node login codex');
}

async function pasteCommand(args) {
  const type = args[0];
  if (type === 'token') {
    const tail = args.slice(1);
    const vendor = readVendor(tail);
    return tokenCommand(vendor, removeVendorArgs(tail));
  }
  throw new Error('Usage: wokey-node paste token --vendor <openai|anthropic>');
}

async function apiStatusCommand(options = {}) {
  const status = await api('/api/status');
  const config = status.config || {};
  const binding = status.binding || {};
  const bridge = status.bridge || {};
  const candidates = await detectCandidates().catch(() => []);
  const importableCount = candidates.filter((item) => item.canImport).length;
  const platform = binding.isBound ? await platformBindingStatus().catch((error) => ({ error })) : null;
  const platformCredentials = binding.isBound ? await platformCredentialsStatus().catch((error) => ({ error, data: [] })) : null;
  const activeCredentials = activeNodeCredentials(platformCredentials?.data);

  if (options.compact) {
    printStatusBlock(config, binding, bridge, importableCount, platform, activeCredentials, platformCredentials, { compact: true });
    return options.returnStatus ? status : undefined;
  }

  printStatusBlock(config, binding, bridge, importableCount, platform, activeCredentials, platformCredentials);
  return options.returnStatus ? status : undefined;
}

async function platformBindingStatus() {
  return api('/api/platform/binding-status');
}

async function platformCredentialsStatus() {
  return api('/api/platform/credentials');
}

function printStatusBlock(config, binding, bridge, importableCount, platform, activeCredentials = [], platformCredentials = null, options = {}) {
  if (!options.compact) printHeader(text.statusTitle);
  console.log(`${blue(text.version)} ${green(config.nodeVersion || 'unknown')}`);
  console.log(`${blue(text.nodeId)} ${green(config.nodeId || 'unknown')}`);
  if (config.providerId && config.providerId !== 'dev') console.log(`${blue(text.providerId)} ${green(config.providerId)}`);
  console.log(`${blue(text.bound)} ${binding.isBound ? green(text.yes) : red(text.no)}`);
  console.log(`${blue(text.bridge)} ${bridge.connected ? green(text.connected) : yellow(text.disconnected)}`);
  console.log(`${blue(text.importableLocalCredentials)} ${importableCount > 0 ? green(String(importableCount)) : yellow('0')}`);
  if (binding.isBound) {
    const credentialCount = platformCredentials?.error ? text.platformUnavailable : String(activeCredentials.length);
    console.log(`${blue(text.authorizedNodeCredentials)} ${activeCredentials.length > 0 ? green(credentialCount) : yellow(credentialCount)}`);
  }
  if (options.compact) return;

  if (binding.isBound) {
    const server = platform?.server || {};
    const serverStatus = platform?.error ? text.platformUnavailable : server.status || text.platformUnavailable;
    const nodeStatus = server.nodeStatus || (bridge.connected ? text.connected : text.disconnected);
    console.log(`${blue(text.serverBinding)} ${serverStatus === 'bound' ? green(text.verified) : yellow(String(serverStatus))}`);
    console.log(`${blue(text.platformNodeStatus)} ${nodeStatus === 'online' || nodeStatus === text.connected ? green(String(nodeStatus)) : yellow(String(nodeStatus))}`);
    console.log(`${blue(text.localConsole)} http://127.0.0.1:${process.env.PROVIDER_CONSOLE_PORT || '16888'}/`);
    printAuthorizedCredentials(activeCredentials, platformCredentials);
  } else {
    console.log(`${blue(text.localConsole)} http://127.0.0.1:${process.env.PROVIDER_CONSOLE_PORT || '16888'}/`);
    console.log(`${blue(text.nextStep)} ${text.nextBindNode}`);
  }
}

function activeNodeCredentials(credentials) {
  return Array.isArray(credentials)
    ? credentials.filter((item) => ['active', 'paused'].includes(String(item?.status || '')))
    : [];
}

function printAuthorizedCredentials(credentials, platformCredentials) {
  console.log(`${blue(text.authorizedCredentialDetails)}`);
  if (platformCredentials?.error) {
    console.log(`  ${yellow(text.platformUnavailable)}`);
    return;
  }
  if (!credentials.length) {
    console.log(`  ${yellow(text.noAuthorizedNodeCredentials)}`);
    return;
  }
  credentials.forEach((credential, index) => {
    const id = credential.credentialBindingId || credential.id || 'unknown';
    const identity = credential.accountEmail || credential.organizationId || credential.claudeCodeAccountUuid || '';
    const suffix = identity ? ` (${identity})` : '';
    console.log(`  ${green(`${index + 1}.`)} ${credentialVendorLabel(credential.vendor)} ${text.credentialIdLabel}: ${green(String(id))} ${text.statusLabel}: ${credentialStatusText(credential.status)}${suffix}`);
  });
}

function credentialVendorLabel(vendor) {
  if (vendor === 'anthropic') return 'Claude';
  if (vendor === 'openai') return 'Codex';
  return vendor || 'OAuth';
}

function credentialStatusText(status) {
  const value = String(status || 'unknown');
  if (value === 'active') return green(value);
  if (value === 'paused') return yellow(value);
  return yellow(value);
}

function printBindingInstructions(status) {
  const config = status.config || {};
  const binding = status.binding || {};
  const localPort = process.env.PROVIDER_NODE_TUNNEL_PORT || '16889';
  const remotePort = process.env.PROVIDER_CONSOLE_PORT || '16888';
  printHeader(text.bindTitle);
  console.log(yellow(text.notBoundYet));
  console.log(`\n${blue(text.getBindingCode)}`);
  console.log(`  ${text.bindStep1}`);
  console.log(`  ${text.bindStep2}`);
  console.log(`  ${text.bindStep3}`);
  console.log(`\n${blue(text.tunnelHelp)}`);
  console.log(`  ${green(`ssh -L ${localPort}:127.0.0.1:${remotePort} <user>@<server>`)}`);
  console.log(`  ${green(`http://127.0.0.1:${localPort}/`)}`);
  console.log(`\n${blue(text.nodeId)} ${green(config.nodeId || 'unknown')}`);
  if (binding.platformBindUrl) console.log(`${blue(text.platformBindUrl)} ${binding.platformBindUrl}`);
  console.log(`\n${blue(text.cliBindingCommand)}`);
  console.log(`  ${green('wokey-node bind --value bind_...')}`);
}

async function pause(rl) {
  await rl.question(`\n${yellow(text.pressEnter)}`);
  console.log('');
}

async function chooseAndImport(candidates, rl) {
  const answer = await rl.question(text.importWhich);
  const selected = await selectCandidate(candidates, answer.trim(), { alreadyPrinted: true });
  await importCandidate(selected);
}

async function importCandidate(selected) {
  const result = await api('/api/platform/credentials/authorize-local', {
    method: 'POST',
    body: {
      source: selected.source,
      path: selected.path,
    },
  });
  printAuthorizationResult(result, selected.vendor);
}

async function tokenCommand(vendor, args) {
  const raw = await readPayload(args, text.oauthPrompt);
  const parsed = parseManualOAuthTokenInput(raw);
  if (!parsed?.accessToken) throw new Error(text.oauthAccessTokenRequired);
  if (vendor === 'openai' && !parsed.refreshToken) throw new Error(text.oauthRefreshTokenRequired);
  const result = await api('/api/platform/credentials/authorize-token', {
    method: 'POST',
    body: { ...parsed, vendor },
  });
  printAuthorizationResult(result, vendor);
}

async function pasteTokenInteractive(rl, vendor) {
  const token = await readInteractiveOAuthPayload(rl);
  const parsed = parseManualOAuthTokenInput(token);
  if (!parsed?.accessToken) throw new Error(text.oauthAccessTokenRequired);
  if (vendor === 'openai' && !parsed.refreshToken) throw new Error(text.oauthRefreshTokenRequired);
  const result = await api('/api/platform/credentials/authorize-token', {
    method: 'POST',
    body: { ...parsed, vendor },
  });
  printAuthorizationResult(result, vendor);
}

async function codexDeviceCommand() {
  const started = await api('/api/oauth/codex/device/start', {
    method: 'POST',
    body: {},
  });
  console.log(`${text.codexOpen} ${started.verificationUrl}`);
  console.log(`${blue(text.code)} ${green(started.userCode)}`);
  console.log(yellow(text.waitingAuthorization));

  const intervalMs = Math.max(2, Number(started.interval) || 5) * 1000;
  const expiresAt = Number(started.expiresAt) || Date.now() + 15 * 60 * 1000;
  while (Date.now() < expiresAt) {
    await sleep(intervalMs);
    const polled = await api('/api/oauth/codex/device/poll', {
      method: 'POST',
      body: { deviceAuthId: started.deviceAuthId },
    });
    if (polled.status === 'pending') {
      process.stdout.write('.');
      continue;
    }
    if (polled.status === 'succeeded') {
      process.stdout.write('\n');
      printAuthorizationResult(polled.authorization || polled, 'openai');
      return;
    }
    throw new Error(`Device authorization ${polled.status || 'failed'}.`);
  }
  throw new Error('Device authorization expired.');
}

async function detectCandidates() {
  const result = await api('/api/oauth/local/detect');
  return Array.isArray(result.data) ? result.data : [];
}

async function selectCandidate(candidates, value, options = {}) {
  if (value) {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 1 || index > candidates.length) {
      throw new Error(zh ? `候选编号必须在 1 到 ${candidates.length} 之间。` : `Candidate number must be between 1 and ${candidates.length}.`);
    }
    return candidates[index - 1];
  }

  if (!options.alreadyPrinted) printCandidates(candidates);
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(text.importWhich);
    return selectCandidate(candidates, answer.trim(), { alreadyPrinted: true });
  } finally {
    rl.close();
  }
}

function printCandidates(candidates) {
  candidates.forEach((item, index) => {
    const status = item.canImport ? green(text.importable) : yellow(item.status || text.unavailable);
    const identity = item.accountEmail || item.organizationId || item.claudeCodeAccountUuid || '';
    const suffix = identity ? ` (${identity})` : '';
    const path = item.path ? `\n    ${text.pathLabel}: ${item.path}` : '';
    const reason = item.reason ? `\n    ${text.reasonLabel}: ${item.reason}` : '';
    console.log(`${green(`${index + 1}.`)} ${item.label || item.source} [${item.vendor}] ${status}${suffix}${path}${reason}`);
  });
}

function printAuthorizationResult(result, vendor) {
  const credential = result.credential || result.data || result;
  const id = credential.credentialBindingId || credential.id || result.credentialBindingId;
  console.log(green(`${text.authorized} ${vendorLabel(vendor)} ${text.credential}${id ? `: ${id}` : '.'}`));
}

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: {} };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(String(init.method).toUpperCase())) {
    init.headers['x-wokey-csrf'] = await getCsrfToken();
  }
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, init);
  } catch {
    throw new Error(`${text.consoleUnreachable}: ${baseUrl}. ${text.startWithRestart}`);
  }
  const responseText = await response.text();
  const data = responseText ? parseJson(responseText) : {};
  if (!response.ok) {
    const message = data.message || data.error || responseText || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data;
}

async function getCsrfToken() {
  if (csrfToken) return csrfToken;
  let response;
  try {
    response = await fetch(`${baseUrl}/api/csrf`);
  } catch {
    throw new Error(`${text.consoleUnreachable}: ${baseUrl}. ${text.startWithRestart}`);
  }
  const responseText = await response.text();
  const data = responseText ? parseJson(responseText) : {};
  if (!response.ok || !data.token) throw new Error(data.error || responseText || 'csrf_token_unavailable');
  csrfToken = data.token;
  return csrfToken;
}

async function readPayload(args, prompt) {
  const fileFlagIndex = args.findIndex((arg) => arg === '--file' || arg === '-f');
  if (fileFlagIndex >= 0) {
    const path = args[fileFlagIndex + 1];
    if (!path) throw new Error(text.fileRequiresPath);
    return readFile(path, 'utf8');
  }
  const valueFlagIndex = args.findIndex((arg) => arg === '--value' || arg === '-v');
  if (valueFlagIndex >= 0) {
    const value = args[valueFlagIndex + 1];
    if (!value) throw new Error(text.valueRequiresValue);
    return value;
  }
  if (!input.isTTY) return readStdin();
  console.log(prompt);
  return readStdin();
}

async function readStdin() {
  let value = '';
  for await (const chunk of input) value += chunk;
  return value.trim();
}

async function readInteractiveOAuthPayload(rl) {
  output.write(text.oauthInlinePrompt);
  return new Promise((resolve, reject) => {
    const lines = [];
    let multiline = false;
    const cleanup = () => {
      rl.off('line', onLine);
      rl.off('close', onClose);
    };
    const finish = (value) => {
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => fail(new Error('Aborted with Ctrl+D'));
    const onLine = (line) => {
      lines.push(line);
      const value = lines.join('\n');
      if (!multiline) {
        if (!looksLikeJsonStart(value) || isCompleteJson(value)) {
          finish(value);
          return;
        }
        multiline = true;
        console.log(yellow(text.oauthMultilineContinue));
        return;
      }
      if (line.trim() === '') {
        fail(new Error(text.oauthJsonInvalid));
        return;
      }
      if (isCompleteJson(value)) {
        finish(value);
      }
    };
    rl.on('line', onLine);
    rl.once('close', onClose);
  });
}

function looksLikeJsonStart(value) {
  const trimmed = String(value || '').trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function isCompleteJson(value) {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function readVendor(args) {
  const vendorFlagIndex = args.findIndex((arg) => arg === '--vendor');
  if (vendorFlagIndex >= 0) return normalizeVendor(args[vendorFlagIndex + 1]);
  const first = args.find((arg) => !arg.startsWith('-'));
  return normalizeVendor(first);
}

function removeVendorArgs(args) {
  const vendorFlagIndex = args.findIndex((arg) => arg === '--vendor');
  if (vendorFlagIndex >= 0) {
    return args.filter((_arg, index) => index !== vendorFlagIndex && index !== vendorFlagIndex + 1);
  }
  const firstIndex = args.findIndex((arg) => !arg.startsWith('-'));
  return firstIndex >= 0 ? args.filter((_arg, index) => index !== firstIndex) : args;
}

function parseManualOAuthTokenInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let root = null;
  let source = null;
  try {
    const parsed = JSON.parse(raw);
    root = parsed;
    source = parsed.oauth || parsed.token || parsed.tokens || parsed.claudeAiOauth || parsed;
  } catch {
    if (raw.includes('=') && (raw.includes('access_token') || raw.includes('accessToken'))) {
      const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
      source = Object.fromEntries(params.entries());
    }
  }
  if (!source) return { accessToken: raw.replace(/^bearer\s+/i, ''), tokenType: 'Bearer' };
  const expiresIn = Number(source.expires_in || source.expiresIn || 0);
  const oauthAccount = source.oauthAccount || root?.oauthAccount || {};
  const authClaims = source['https://api.openai.com/auth'] || root?.['https://api.openai.com/auth'] || {};
  return {
    accessToken: source.access_token || source.accessToken,
    refreshToken: source.refresh_token || source.refreshToken,
    idToken: source.id_token || source.idToken,
    tokenType: source.token_type || source.tokenType || 'Bearer',
    expiresAt: source.expires_at || source.expiresAt || (expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined),
    scope: source.scope,
    organizationId: source.organizationId || source.organization_id || source.organization?.uuid || oauthAccount.organizationUuid || oauthAccount.accountUuid || authClaims.chatgpt_account_id || source.account_id,
    accountEmail: source.accountEmail || source.account_email || source.account?.email_address || oauthAccount.emailAddress,
    subscriptionType: source.subscriptionType || source.subscription_type || source.chatgptPlanType || source.chatgpt_plan_type || authClaims.chatgpt_plan_type,
    subscriptionDisplayName: source.subscriptionDisplayName || source.subscription_display_name,
    rateLimitTier: source.rateLimitTier || root?.rateLimitTier,
    organizationRateLimitTier: source.organizationRateLimitTier || oauthAccount.organizationRateLimitTier,
    userRateLimitTier: source.userRateLimitTier || oauthAccount.userRateLimitTier,
    organizationType: source.organizationType || oauthAccount.organizationType,
    claudeCodeUserId: source.claudeCodeUserId || source.claude_code_user_id,
    claudeCodeAccountUuid: source.claudeCodeAccountUuid || source.claude_code_account_uuid || oauthAccount.accountUuid,
  };
}

function normalizeVendor(value) {
  if (value === 'openai' || value === 'codex') return 'openai';
  if (value === 'anthropic' || value === 'claude') return 'anthropic';
  throw new Error(text.vendorRequired);
}

function vendorLabel(vendor) {
  if (vendor === 'anthropic') return 'Claude';
  if (vendor === 'openai') return 'OpenAI/Codex';
  return vendor || 'OAuth';
}

function printHeader(title) {
  const line = '========================================';
  console.log('');
  console.log(blue(line));
  console.log(`${blue('  ')}${bold(title)}`);
  console.log(blue(line));
}

function paint(color, value) {
  return useColor ? `${colors[color]}${value}${colors.plain}` : value;
}

function red(value) {
  return paint('red', value);
}

function green(value) {
  return paint('green', value);
}

function yellow(value) {
  return paint('yellow', value);
}

function blue(value) {
  return paint('label', value);
}

function bold(value) {
  return paint('bold', value);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function formatCliError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('anthropic_browser_session_challenge') || message.includes('browser security challenge')) {
    return text.claudeOAuthChallenge;
  }
  if (message.includes('Claude browser OAuth import failed')) {
    return text.claudeOAuthChallengeFailed;
  }
  return message;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage() {
  console.log(text.usage);
  process.exit(64);
}
