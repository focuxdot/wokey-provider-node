let csrfToken = window.__WOKEY_CSRF__;
let csrfTokenRefresh = null;
// 暂停「本机自动扫描授权凭证」(Codex auth.json / Claude Code 本地导入)。
// 自动扫描在本机凭证读不到、Claude Desktop≠Claude Code、以及导入后本地
// 会话继续刷新导致的 refresh-token 旋转门等
// 场景下问题较多,故暂时只隐藏 UI:不渲染自动扫描卡片、不显示「扫描授权凭证」按钮、
// 加载时不自动调用 /api/oauth/local/detect。手动添加(OAuth / 设备码 / 粘贴 token)
// 与已绑定的 Platform 凭证卡片不受影响。恢复:把此常量改回 true 并重新发版。
const LOCAL_AUTH_SCAN_ENABLED = false;
const messages = {
  en: {
    appTitle: 'Wokey Node Management',
    loading: 'Loading',
    languageToggle: 'Switch language',
    themeToggle: 'Toggle light / dark theme',
    settingsToggle: 'Node settings',
    footerBrand: 'Wokey Provider Node',
    english: 'English',
    simplifiedChinese: '中文',
    heroSubtitle: 'Connect this node to the platform first, then bind credentials.',
    localReadyTitle: 'Local service connected',
    localReadyBody: 'Local node details are ready for platform binding.',
    nodeIdPrefix: 'Node ID',
    bindTitle: 'Connect from Provider page',
    bindBody: 'Use the Provider page to generate a one-time binding code and return here automatically.',
    bindBodyPrefix: 'Use one-click binding from the ',
    providerPageLink: 'Provider page',
    bindBodySuffix: ', or paste a binding code here.',
    openProviderPage: 'Open Provider page',
    manualBindingSummary: 'Use a binding code instead',
    manualBindingBody: 'If automatic binding cannot open the local console, paste the binding code here.',
    bindingPlaceholder: 'Paste the binding code starting with bind_',
    bindAction: 'Bind manually',
    bindingCodeRequired: 'Binding code is required.',
    autoBindingStarted: 'Binding this local node...',
    bindingHelpLink: 'I cannot find the binding code',
    bindingHelpPrefix: 'Open ',
    bindingHelpLinkText: 'https://wokey.ai/provider',
    bindingHelpSuffix: ', sign in to the Provider page, then copy the binding code from the Node binding area.',
    refreshNodeStatus: 'Refresh node status',
    refreshingNodeStatus: 'Refreshing node status...',
    nodeStatusRefreshed: 'Node status refreshed.',
    nodeBindingExpired:
      'This local node binding is no longer accepted by Platform. Paste a new binding code to reconnect this node.',
    nodePausedNotice:
      'This node is paused and has stopped receiving requests. Resume it on the Provider page, then click "Refresh node status" to continue.',
    nodeBindingUnavailable:
      'Could not verify Platform binding. Local credentials are shown, but authorization state may be stale.',
    platformTemporarilyUnavailable: 'Platform is temporarily unavailable. Please try again in a moment.',
    platformUnreachable:
      "Cannot reach the platform (tried the direct endpoint and the fallback). Check this node's network and that the server IP or domain is reachable from here.",
    credentialsTitle: 'Credentials',
    credentialsBody: 'Detected local OAuth credentials and OAuth browser flows available to this node.',
    credentialsScanDisabledBody: 'Add a credential to this node with the browser OAuth flow, device code, or by pasting a token.',
    scanAgain: 'Scan OAuth',
    scanningAuthButton: 'Scanning...',
    credentialsLoading: 'Scanning auth',
    credentialsLoadingBody: 'Reading local auth files for this node.',
    noCredentialsTitle: 'No local auth detected yet',
    noCredentialsBody: 'No importable local auth was found yet.',
    noCredentialsScanDisabledTitle: 'No credentials bound yet',
    noCredentialsScanDisabledBody:
      'Add one with “Add a credential manually” below (browser OAuth / device code / paste token).',
    oauthCredential: 'Local OAuth Token',
    detectedLocalCredential: 'Detected local auth',
    detectedOAuthBrowserFlow: 'OAuth browser flow',
    importLocalCredential: 'Authorize',
    reauthorizeLocalCredential: 'Re-authorize',
    importingLocalCredential: 'Authorizing...',
    importLocalCredentialDone: 'Credential authorized and saved on Platform.',
    credentialAuthorized: 'Credential authorized and saved on Platform.',
    localCredentialAuthorized: 'Authorized',
    localCredentialPendingAuthorization: 'Needs authorization',
    localCredentialReadyToAuthorize: 'Ready to authorize',
    localCredentialUnavailable: 'Unavailable',
    startOAuthBrowserFlow: 'Start OAuth flow',
    browserAuthorizationRequired: 'Open the OAuth browser flow before using this credential.',
    pathLabel: 'Path:',
    accountLabel: 'Account:',
    subscriptionTypeLabel: 'Subscription:',
    recordCountLabel: 'Records:',
    credentialIdsLabel: 'Credential IDs:',
    expiresLabel: 'Expires:',
    reasonLabel: 'Reason:',
    codexAuthJsonLabel: 'Codex',
    claudeCodeSessionLabel: 'Claude Code',
    codexOAuthFlowLabel: 'ChatGPT/OpenAI OAuth',
    claudeOAuthFlowLabel: 'Claude OAuth',
    claudeMissingReason: 'Claude Code config was not found.',
    claudeCredentialsAuthorizationReason: 'Click Authorize to import Claude Code OAuth from its local credentials file.',
    claudeCredentialsMissingReason: 'Claude Code OAuth credential was not found in .credentials.json.',
    claudeCredentialsMissingTokensReason: 'Claude Code OAuth credential is missing access or refresh token.',
    codexMissingReason: 'Codex auth.json was not found.',
    boundBadge: 'Bound',
    pausedBadge: 'Paused',
    revokedBadge: 'Revoked',
    disabledBadge: 'Disabled',
    needsAttention: 'Needs attention',
    boundToLabel: 'Bound to:',
    currentNode: 'Current node',
    statusLabel: 'Status:',
    lastCheckedLabel: 'Last checked:',
    fix: 'Fix',
    startClaudeOAuth: 'Start Claude OAuth from the manual add area below.',
    addCredentialTitle: 'Add a credential manually (Recommended for personal use and sharing)',
    addCredentialBody: 'This node can authorize and add multiple Claude / Codex accounts.',
    chooseProvider: 'Choose account type',
    claudeOAuth: 'Sign in with Claude OAuth',
    codexOAuth: 'Use device code authorization',
    claudeOAuthTitle: 'Claude OAuth authorization',
    claudeOAuthBody: 'Authorize in Claude, then paste the returned URL or code here.',
    openClaudeAuthorize: 'Authorize on Claude.ai',
    copyAuthorizationLink: 'Copy link',
    authorizationLinkCopied: 'Authorization link copied.',
    redirectCodePlaceholder: 'Paste callback URL or code...',
    submitAuthorizationCode: 'Submit',
    authorizationLinkRequired: 'Generate an authorization link first.',
    authorizationCodeRequired: 'Paste the returned authorization code first.',
    authorizationSubmitFailed: 'Authorization failed. Generate a new authorization link and submit a fresh code.',
    authorizationFlowExpired:
      'This authorization flow has expired. Refresh this page, generate a new Claude authorization link, then submit the new code.',
    authorizationCodeLinkMismatch:
      'This code does not match the current authorization link. Refresh this page, generate a new Claude authorization link, then submit the new code.',
    pasteOAuthTokenTitle: 'Other option: paste OAuth credential',
    pasteOAuthTokenBody:
      'Use this only if you already have a complete token or auth.json. This is similar to importing a detected local credential.',
    importOAuthToken: 'Import token',
    oauthTokenPlaceholder: '{"access_token":"...","refresh_token":"..."}',
    oauthTokenRequired: 'Paste OAuth token JSON first.',
    oauthAccessTokenRequired: 'OAuth access token is required.',
    oauthRefreshTokenRequired:
      'OpenAI/Codex authorization must include a refresh token. Paste a complete Codex auth.json or OAuth token JSON.',
    oauthTokenImported: 'OAuth token authorized and saved on Platform.',
    useDeviceCode: 'Use device code',
    deviceCodeBody: 'Click to generate a device code and open the ChatGPT authorization page.',
    startDeviceCode: 'Authorize in ChatGPT',
    deviceCodeLabel: 'Code to enter on the ChatGPT page',
    deviceCodeHint: 'When ChatGPT asks for the code shown in your terminal, use this code.',
    grokOAuth: 'Use device code authorization',
    grokDeviceCodeBody: 'Click to generate a device code and open the Grok authorization page.',
    startGrokDeviceCode: 'Authorize in Grok',
    grokDeviceCodeLabel: 'Code to enter on the Grok page',
    grokDeviceCodeHint: 'When Grok asks for the code shown in your terminal, use this code.',
    copyDeviceCode: 'Copy device code',
    deviceCodeStartFirst: 'Generate a device code first.',
    deviceCodeOpened:
      'ChatGPT authorization is open. Enter the device code shown here, then return to this page; this node will save the credential automatically.',
    deviceCodeCopyBlocked:
      'The browser blocked copy. The device code is selected; copy it manually.',
    otherOptions: 'Other Options',
    oauthResultPlaceholder: 'OAuth operation results will appear here.',
    unbindTitle: 'Unbind Node',
    unbindBody:
      'This removes the link between this console and your Provider account. Local credentials stay on this machine.',
    unbindAction: 'Unbind Node',
    uninstallAction: 'Uninstall Node',
    uninstallTitle: 'Uninstall Provider Node',
    uninstallBody:
      'This will open a local terminal uninstall command. Provider Node will stop running and the installed app files will be removed.',
    uninstallKeepData: 'Keep local config and OAuth credentials on this machine',
    uninstallConfirmHint: 'Type UNINSTALL to continue.',
    uninstallConfirmPlaceholder: 'UNINSTALL',
    uninstallConfirmRequired: 'Type UNINSTALL to confirm uninstall.',
    uninstallStart: 'Open uninstall',
    uninstallStarted: 'The uninstall command was opened in Terminal. Follow the local prompts to finish removal.',
    uninstallCommandFallback: 'Run this command in a local terminal to uninstall Provider Node: ',
    cancel: 'Cancel',
    save: 'Save',
    onlineBound: 'Online',
    localNodeReady: 'Local node ready',
    providerPrefix: 'Provider',
    nodePrefix: 'Node',
    notConnected: 'Last synced: not connected',
    nodeBoundLoadingCredentials: 'Node bound. Loading credentials...',
    nodeBindingInvalidCredentials:
      'Node binding credentials were rejected by Platform. Rebind this node before authorizing credentials.',
    unbindConfirm: 'Unbind this node from your Provider account?',
    safetyLabel: 'Safety:',
    credentialIdLabel: 'Credential ID:',
    createdLabel: 'Created:',
    updatedLabel: 'Updated:',
    statusUpdatedLabel: 'Status updated:',
    lastUsedLabel: 'Last used:',
    cooldownUntilLabel: 'Cooldown until:',
    errorCodeLabel: 'Last error:',
    encryptedFallback: 'encrypted',
    recently: 'recently',
    never: 'never',
    couldNotLoadCredentials: 'Could not load platform credentials: ',
    oauthWiringNext: ' OAuth wiring will be added next.',
    openDeviceUrl: 'Open ',
    enterCodeReturn: ' and enter the code, then return here.',
    deviceCodeCopied: 'Device code copied.',
    authorizationUrlGenerated: 'Authorization URL generated.',
    deviceWaiting: 'Waiting for device authorization...',
    deviceAuthorized: 'Device authorization succeeded. Credential saved on Platform.',
    deviceAuthorizationExpired: 'This device authorization session is no longer available. Start device code authorization again.',
  },
  zh: {
    appTitle: 'Wokey 节点管理',
    loading: '加载中',
    languageToggle: '切换语言',
    themeToggle: '切换亮色 / 暗色主题',
    settingsToggle: '节点设置',
    footerBrand: 'Wokey Provider Node',
    english: 'English',
    simplifiedChinese: '中文',
    heroSubtitle: '先把节点和平台连通，再绑定授权凭证。',
    localReadyTitle: '本机已连接',
    localReadyBody: '检测到本地服务，节点信息可用于后续绑定。',
    nodeIdPrefix: '节点 ID',
    bindTitle: '从 Provider 页面连接',
    bindBody: '通过 Provider 页面生成一次性绑定码，并自动回到本页完成连接。',
    bindBodyPrefix: '可在 ',
    providerPageLink: 'Provider 页面',
    bindBodySuffix: ' 一键绑定本机节点，也可以在这里粘贴绑定码。',
    openProviderPage: '前往 Provider 页面绑定',
    manualBindingSummary: '使用绑定码手动连接',
    manualBindingBody: '如果自动绑定没有打开本机控制台，可以在这里粘贴绑定码。',
    bindingPlaceholder: '粘贴 bind_ 开头的绑定码',
    bindAction: '手动绑定',
    bindingCodeRequired: '请先输入绑定码。',
    autoBindingStarted: '正在绑定本机节点...',
    bindingHelpLink: '我没看到绑定码',
    bindingHelpPrefix: '请打开 ',
    bindingHelpLinkText: 'https://wokey.ai/provider',
    bindingHelpSuffix: '，登录 Provider 页面后，在节点绑定区域复制绑定码。',
    refreshNodeStatus: '刷新节点状态',
    refreshingNodeStatus: '正在刷新节点状态...',
    nodeStatusRefreshed: '节点状态已刷新。',
    nodeBindingExpired: '当前本机节点绑定已不被 Platform 接受。请粘贴新的绑定码重新连接当前节点。',
    nodePausedNotice: '该节点已暂停，已停止接收请求。请在 Provider 页面恢复节点，然后点击"刷新节点状态"继续。',
    nodeBindingUnavailable: '暂时无法校验 Platform 绑定状态。本机授权凭证会继续显示，但授权状态可能不是最新。',
    platformTemporarilyUnavailable: '平台暂时不可用，请稍后重试。',
    platformUnreachable: '无法连接平台(已尝试直连入口与回退入口)。请检查本节点网络,确认服务器 IP 或域名从这里可达。',
    credentialsTitle: '授权凭证',
    credentialsBody: '当前节点可使用本机 OAuth 凭证与浏览器 OAuth 流程。',
    credentialsScanDisabledBody: '通过浏览器 OAuth、设备码或粘贴 Token 为当前节点添加授权凭证。',
    scanAgain: '扫描授权凭证',
    scanningAuthButton: '正在扫描...',
    credentialsLoading: '正在扫描授权凭证',
    credentialsLoadingBody: '正在读取本机授权文件。',
    noCredentialsTitle: '还没有检测到本机授权凭证',
    noCredentialsBody: '还没有发现可导入的本机授权凭证。',
    noCredentialsScanDisabledTitle: '还没有绑定授权凭证',
    noCredentialsScanDisabledBody: '请用下方「手动添加授权凭证」来绑定(浏览器 OAuth / 设备码 / 粘贴 Token)。',
    oauthCredential: '本地 OAuth 凭证',
    detectedLocalCredential: '检测到本机授权凭证',
    detectedOAuthBrowserFlow: '浏览器 OAuth 流程',
    importLocalCredential: '授权',
    reauthorizeLocalCredential: '重新授权',
    importingLocalCredential: '正在授权...',
    importLocalCredentialDone: '授权凭证已保存到 Platform。',
    credentialAuthorized: '授权凭证已保存到 Platform。',
    localCredentialAuthorized: '已授权',
    localCredentialPendingAuthorization: '待授权',
    localCredentialReadyToAuthorize: '可授权',
    localCredentialUnavailable: '不可用',
    startOAuthBrowserFlow: '启动 OAuth 流程',
    browserAuthorizationRequired: '需要先打开浏览器 OAuth 流程，才能使用这个凭证。',
    pathLabel: '路径：',
    accountLabel: '账号：',
    subscriptionTypeLabel: '订阅类型：',
    recordCountLabel: '记录数：',
    credentialIdsLabel: '凭证 ID：',
    expiresLabel: '过期时间：',
    reasonLabel: '原因：',
    codexAuthJsonLabel: 'Codex',
    claudeCodeSessionLabel: 'Claude Code',
    codexOAuthFlowLabel: 'ChatGPT/OpenAI OAuth',
    claudeOAuthFlowLabel: 'Claude OAuth',
    claudeMissingReason: '没有找到 Claude Code 配置。',
    claudeCredentialsAuthorizationReason: '点击授权后导入 Claude Code 本地凭证文件中的 OAuth 凭证。',
    claudeCredentialsMissingReason: '没有在 .credentials.json 找到 Claude Code OAuth 凭证。',
    claudeCredentialsMissingTokensReason: 'Claude Code OAuth 凭证缺少访问令牌或刷新令牌。',
    codexMissingReason: '没有找到 Codex auth.json。',
    boundBadge: '已绑定',
    pausedBadge: '已暂停',
    revokedBadge: '已撤销',
    disabledBadge: '已失效',
    needsAttention: '需要处理',
    boundToLabel: '绑定到：',
    currentNode: '当前节点',
    statusLabel: '状态：',
    lastCheckedLabel: '上次检查：',
    fix: '处理',
    startClaudeOAuth: '请在下方手动添加区域开始 Claude OAuth。',
    addCredentialTitle: '手动添加授权凭证（推荐，适合自用与共享）',
    addCredentialBody: '节点可以授权添加多个不同 Claude / Codex 账号',
    chooseProvider: '选择账号类型',
    claudeOAuth: '使用 Claude OAuth 登录',
    codexOAuth: '使用设备码授权',
    claudeOAuthTitle: 'Claude OAuth 授权',
    claudeOAuthBody: '在 Claude 完成授权后，把返回的 URL 或授权码粘贴到这里提交。',
    openClaudeAuthorize: '在 Claude.ai 授权',
    copyAuthorizationLink: '复制链接',
    authorizationLinkCopied: '授权链接已复制。',
    redirectCodePlaceholder: '粘贴回调 URL 或授权码...',
    submitAuthorizationCode: '提交',
    authorizationLinkRequired: '请先生成授权链接。',
    authorizationCodeRequired: '请先粘贴返回的授权码。',
    authorizationSubmitFailed: '授权失败。请重新生成授权链接，并提交新的授权码。',
    authorizationFlowExpired: '这次授权流程已过期。请刷新页面，重新生成 Claude 授权链接，再提交新的授权码。',
    authorizationCodeLinkMismatch:
      '这个授权码不属于当前授权链接。请刷新页面，重新生成 Claude 授权链接，再提交新的授权码。',
    pasteOAuthTokenTitle: '其他方式：粘贴 OAuth 凭证',
    pasteOAuthTokenBody:
      '仅在你已经有完整 token 或 auth.json 时使用，作用类似导入已扫描到的本机凭证。',
    importOAuthToken: '导入 OAuth 凭证',
    oauthTokenPlaceholder: '{"access_token":"...","refresh_token":"..."}',
    oauthTokenRequired: '请先粘贴 OAuth token JSON。',
    oauthAccessTokenRequired: '缺少 OAuth 访问令牌。',
    oauthRefreshTokenRequired:
      'OpenAI/Codex 授权必须包含刷新令牌。请粘贴完整 Codex auth.json 或完整 OAuth token JSON。',
    oauthTokenImported: 'OAuth 凭证已授权并保存到 Platform。',
    useDeviceCode: '使用设备码',
    deviceCodeBody: '点击后会生成设备码并打开 ChatGPT 授权页。',
    startDeviceCode: '去 ChatGPT 授权',
    deviceCodeLabel: 'ChatGPT 页面要输入的 9 位代码',
    deviceCodeHint: 'ChatGPT 页面提示“终端上显示的代码”时，请使用这里的代码。',
    grokOAuth: '使用设备码授权',
    grokDeviceCodeBody: '点击后会生成设备码并打开 Grok 授权页。',
    startGrokDeviceCode: '去 Grok 授权',
    grokDeviceCodeLabel: 'Grok 页面要输入的代码',
    grokDeviceCodeHint: 'Grok 页面提示“终端上显示的代码”时，请使用这里的代码。',
    copyDeviceCode: '复制设备码',
    deviceCodeStartFirst: '请先点击上方按钮生成设备码。',
    deviceCodeOpened: 'ChatGPT 授权页已打开。请把这里的设备码填到 ChatGPT 页面；授权完成后回到本页，节点会自动保存凭证。',
    deviceCodeCopyBlocked:
      '浏览器阻止了复制。已为你选中设备码，请手动复制。',
    otherOptions: '其他方式',
    oauthResultPlaceholder: 'OAuth 操作结果会显示在这里。',
    unbindTitle: '解绑节点',
    unbindBody: '解除当前控制台与 Provider 账号的绑定，本地授权凭证仍保留在这台机器上。',
    unbindAction: '解绑节点',
    uninstallAction: '卸载节点',
    uninstallTitle: '卸载 Provider Node',
    uninstallBody: '将打开本机终端卸载命令。Provider Node 会停止运行，已安装的软件文件会被移除。',
    uninstallKeepData: '保留这台机器上的本地配置和 OAuth 授权凭证',
    uninstallConfirmHint: '输入“卸载”继续。',
    uninstallConfirmPlaceholder: '卸载',
    uninstallConfirmRequired: '请输入“卸载”确认卸载。',
    uninstallStart: '打开卸载',
    uninstallStarted: '已打开终端卸载命令。请按本机提示完成移除。',
    uninstallCommandFallback: '请在本机终端运行以下命令卸载 Provider Node：',
    cancel: '取消',
    save: '保存',
    onlineBound: '在线',
    localNodeReady: '本地节点就绪',
    providerPrefix: 'Provider',
    nodePrefix: '节点',
    notConnected: '未连接',
    nodeBoundLoadingCredentials: '节点已绑定，正在加载授权凭证...',
    nodeBindingInvalidCredentials: '节点绑定凭证已被 Platform 拒绝。请先重新绑定当前节点，再授权凭证。',
    unbindConfirm: '确认解绑当前节点？',
    safetyLabel: '安全等级：',
    credentialIdLabel: '凭证 ID：',
    createdLabel: '创建时间：',
    updatedLabel: '更新时间：',
    statusUpdatedLabel: '状态更新时间：',
    lastUsedLabel: '上次使用：',
    cooldownUntilLabel: '冷却到：',
    errorCodeLabel: '上次错误：',
    encryptedFallback: '已加密',
    recently: '最近',
    never: '从未',
    couldNotLoadCredentials: '无法加载授权凭证：',
    oauthWiringNext: ' OAuth 流程稍后接入。',
    openDeviceUrl: '打开 ',
    enterCodeReturn: ' 并输入设备码，然后回到这里。',
    deviceCodeCopied: '设备码已复制。',
    authorizationUrlGenerated: '授权 URL 已生成。',
    deviceWaiting: '正在等待设备授权...',
    deviceAuthorized: '设备授权成功，授权凭证已保存到 Platform。',
    deviceAuthorizationExpired: '这次设备授权会话已失效，请重新开始设备码授权。',
  },
};

// When local auto-scan is paused, swap every copy string that implies a scan ran
// over to its manual-add wording. Centralised here so flipping LOCAL_AUTH_SCAN_ENABLED
// back to true restores all of them at once — no per-render conditionals to revert.
if (!LOCAL_AUTH_SCAN_ENABLED) {
  for (const strings of [messages.en, messages.zh]) {
    strings.credentialsBody = strings.credentialsScanDisabledBody;
    strings.noCredentialsTitle = strings.noCredentialsScanDisabledTitle;
    strings.noCredentialsBody = strings.noCredentialsScanDisabledBody;
  }
}

let statusState = null;
let activeDeviceAuthId = null;
let activeCodexDeviceCode = null;
let activeXaiDeviceCode = null;
let activeProvider = 'claude';
let activeClaudeOAuth = null;
let platformCredentials = null;
let localCredentialCandidates = null;
let devicePollTimer = null;
let devicePollRunId = 0;
let lastCredentialScanAt = null;
let authScanInFlight = null;
let consumedLaunchBindingKey = '';
let launchBindingInFlight = null;
let locale =
  localStorage.getItem('providerConsoleLocale') ||
  ((navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');

function t(key) {
  return (messages[locale]?.[key]) || messages.en[key] || key;
}

function nodeConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    const panel = document.createElement('div');
    const title = document.createElement('h3');
    const body = document.createElement('p');
    const actions = document.createElement('div');
    const cancel = document.createElement('button');
    const confirm = document.createElement('button');
    const isDanger = options.tone === 'danger';

    backdrop.className = 'modal-backdrop visible';
    panel.className = 'modal';
    actions.className = 'modal-actions';
    cancel.className = 'secondary-btn';
    confirm.className = 'primary-btn';
    if (isDanger) confirm.style.background = 'var(--danger)';
    title.textContent = options.title || (locale === 'zh' ? '确认操作' : 'Confirm Action');
    body.textContent = message;
    body.style.color = 'var(--muted)';
    body.style.lineHeight = '1.6';
    cancel.type = 'button';
    confirm.type = 'button';
    cancel.textContent = t('cancel');
    confirm.textContent = options.confirmLabel || (locale === 'zh' ? '确定' : 'Confirm');

    function close(result) {
      backdrop.remove();
      document.removeEventListener('keydown', onKeyDown);
      resolve(result);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') close(false);
    }

    cancel.addEventListener('click', () => close(false));
    confirm.addEventListener('click', () => close(true));
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) close(false);
    });
    document.addEventListener('keydown', onKeyDown);

    actions.append(cancel, confirm);
    panel.append(title, body, actions);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    confirm.focus();
  });
}

function nodeUninstallConfirm() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    const panel = document.createElement('div');
    const title = document.createElement('h3');
    const body = document.createElement('p');
    const hint = document.createElement('p');
    const input = document.createElement('input');
    const checkLabel = document.createElement('label');
    const keepData = document.createElement('input');
    const keepText = document.createElement('span');
    const actions = document.createElement('div');
    const cancel = document.createElement('button');
    const confirm = document.createElement('button');
    const expected = locale === 'zh' ? '卸载' : 'UNINSTALL';

    backdrop.className = 'modal-backdrop visible';
    panel.className = 'modal';
    actions.className = 'modal-actions';
    input.className = 'confirm-input';
    checkLabel.className = 'check-row';
    cancel.className = 'secondary-btn';
    confirm.className = 'primary-btn';
    confirm.style.background = 'var(--danger)';

    title.textContent = t('uninstallTitle');
    body.textContent = t('uninstallBody');
    body.style.color = 'var(--muted)';
    body.style.lineHeight = '1.6';
    hint.textContent = t('uninstallConfirmHint');
    hint.style.color = 'var(--muted)';
    hint.style.fontSize = '13px';
    hint.style.marginTop = '14px';
    input.placeholder = t('uninstallConfirmPlaceholder');
    input.autocomplete = 'off';
    keepData.type = 'checkbox';
    keepData.checked = true;
    keepText.textContent = t('uninstallKeepData');
    cancel.type = 'button';
    confirm.type = 'button';
    cancel.textContent = t('cancel');
    confirm.textContent = t('uninstallStart');
    confirm.disabled = true;

    function isConfirmed() {
      return input.value.trim() === expected;
    }
    function close(result) {
      backdrop.remove();
      document.removeEventListener('keydown', onKeyDown);
      resolve(result);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') close(null);
    }

    input.addEventListener('input', () => {
      confirm.disabled = !isConfirmed();
    });
    cancel.addEventListener('click', () => close(null));
    confirm.addEventListener('click', () => {
      if (!isConfirmed()) return;
      close({ confirm: input.value.trim(), purgeData: !keepData.checked });
    });
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) close(null);
    });
    document.addEventListener('keydown', onKeyDown);

    checkLabel.append(keepData, keepText);
    actions.append(cancel, confirm);
    panel.append(title, body, hint, input, checkLabel, actions);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    input.focus();
  });
}

function applyLocale() {
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  document.title = t('appTitle');
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]'))
    node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
  for (const node of document.querySelectorAll('[data-i18n-aria-label]'))
    node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
  document.querySelectorAll('[data-locale-option]').forEach((node) => {
    const active = node.dataset.localeOption === locale;
    node.classList.toggle('active', active);
    node.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  refreshStatusText();
  setAuthScanButtonLoading(Boolean(authScanInFlight));
}

function closeSettingsMenu() {
  document.getElementById('settingsSwitch')?.classList.remove('open');
  document.getElementById('settingsToggle')?.setAttribute('aria-expanded', 'false');
}

function closeLanguageMenu() {
  document.getElementById('languageSwitch')?.classList.remove('open');
  document.getElementById('languageToggle')?.setAttribute('aria-expanded', 'false');
}

function closeTopMenus() {
  closeLanguageMenu();
  closeSettingsMenu();
}

function toggleSettingsMenu(event) {
  event?.preventDefault();
  event?.stopPropagation();
  const menu = document.getElementById('settingsSwitch');
  const willOpen = !menu?.classList.contains('open');
  closeTopMenus();
  if (menu && willOpen) {
    menu.classList.add('open');
    document.getElementById('settingsToggle')?.setAttribute('aria-expanded', 'true');
  }
}

function toggleLanguageMenu(event) {
  event?.preventDefault();
  event?.stopPropagation();
  const menu = document.getElementById('languageSwitch');
  const willOpen = !menu?.classList.contains('open');
  closeTopMenus();
  if (menu && willOpen) {
    menu.classList.add('open');
    document.getElementById('languageToggle')?.setAttribute('aria-expanded', 'true');
  }
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function syncThemeToggle() {
  document.getElementById('themeToggle')?.setAttribute('aria-pressed', currentTheme() === 'dark' ? 'true' : 'false');
}

function toggleTheme(event) {
  event?.preventDefault();
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('providerConsoleTheme', next);
  } catch (_error) {
    // localStorage may be unavailable (e.g. file://); theme still applies for this session.
  }
  syncThemeToggle();
}

function setLocale(next, event) {
  event?.preventDefault();
  event?.stopPropagation();
  if (next !== 'zh' && next !== 'en') return;
  if (next === locale) {
    closeTopMenus();
    return;
  }
  locale = next;
  localStorage.setItem('providerConsoleLocale', locale);
  closeTopMenus();
  applyLocale();
  renderDynamicMeta();
  if (platformCredentials || localCredentialCandidates)
    renderCredentialGrid(platformCredentials || [], localCredentialCandidates || []);
}

function isCsrfTokenError(response, data) {
  return response.status === 403 && (data?.error === 'csrf_token_required' || data?.message === 'csrf_token_required');
}

async function refreshCsrfToken() {
  if (!csrfTokenRefresh) {
    csrfTokenRefresh = fetch('/api/csrf')
      .then(async (response) => {
        if (!response.ok) throw new Error('csrf_token_refresh_failed');
        const data = await response.json();
        if (!data?.token) throw new Error('csrf_token_refresh_failed');
        csrfToken = data.token;
        return csrfToken;
      })
      .finally(() => {
        csrfTokenRefresh = null;
      });
  }
  return csrfTokenRefresh;
}

async function api(path, options = {}, allowCsrfRetry = true) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (csrfToken) headers['x-wokey-csrf'] = csrfToken;
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const text = await response.text();
  let data = {};
  try {
    if (text) data = JSON.parse(text);
  } catch (_error) {
    // Non-JSON body — typically an nginx 502/503 HTML page while the Platform restarts.
    data = {};
  }
  if (!response.ok && allowCsrfRetry && isCsrfTokenError(response, data)) {
    await refreshCsrfToken();
    return api(path, options, false);
  }
  if (!response.ok) {
    const apiMessage = data.message || data.error?.message || data.error;
    // A server error with no structured message is almost always the Platform being
    // momentarily unreachable (deploy/restart → bare 503/502). Show a friendly localized
    // notice instead of leaking the raw "Service Unavailable" status text or an HTML page.
    const message = apiMessage
      || (response.status >= 500 ? t('platformTemporarilyUnavailable') : (response.statusText || 'Request failed'));
    const error = new Error(message);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function apiWithTimeout(path, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await api(path, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function shortId(value) {
  if (!value) return 'unknown';
  return value.length > 14 ? value.slice(0, 6) + '...' + value.slice(-4) : value;
}

function setToast(id, message, variant) {
  const node = document.getElementById(id);
  if (!node) return;
  node.classList.remove('error', 'success', 'warn');
  if (!message) {
    node.textContent = '';
    node.classList.remove('visible');
    return;
  }
  node.textContent = message;
  if (variant) node.classList.add(variant);
  node.classList.add('visible');
}

function showMessage(message) {
  setToast(statusState?.binding?.isBound ? 'boundResult' : 'unboundResult', message, 'error');
}

function showBindingHelp() {
  const node = document.getElementById(statusState?.binding?.isBound ? 'boundResult' : 'unboundResult');
  if (!node) return;
  const url = 'https://wokey.ai/provider';
  node.innerHTML =
    escapeHtml(t('bindingHelpPrefix')) +
    '<a href="' +
    url +
    '" target="_blank" rel="noreferrer">' +
    escapeHtml(t('bindingHelpLinkText')) +
    '</a>' +
    escapeHtml(t('bindingHelpSuffix'));
  node.classList.add('visible');
}

function dateLabel(value) {
  return value ? new Date(value).toLocaleString() : t('never');
}

function refreshStatusText() {
  const isBound = statusState?.binding?.isBound;
  document.getElementById('topStatus').innerHTML =
    '<span class="dot"></span><span>' + (isBound ? t('onlineBound') : t('localNodeReady')) + '</span>';
}

function renderDynamicMeta() {
  if (!statusState) return;
  const nodeId = statusState.config.nodeId || 'unknown';
  const providerId = statusState.config.providerId || 'unknown';
  document.getElementById('localNodeId').textContent = t('nodeIdPrefix') + ': ' + nodeId;
  document.getElementById('localNodeId').title = nodeId;
  document.getElementById('providerMeta').textContent = t('providerPrefix') + ': ' + providerId;
  document.getElementById('nodeMeta').textContent = t('nodePrefix') + ': ' + nodeId;
  document.getElementById('nodeMeta').title = nodeId;
  const syncAt = statusState.bridge?.lastHeartbeatAt || statusState.bridge?.lastConnectedAt;
  document.getElementById('syncMeta').textContent = syncAt ? dateLabel(syncAt) : t('notConnected');
}

async function refreshStatus(autoScan = true) {
  statusState = await api('/api/status');
  if (statusState.binding?.isBound) await refreshPlatformBindingStatus();
  const isBound = statusState.binding?.isBound;
  refreshStatusText();
  const unbindMenuButton = document.getElementById('settingsUnbindButton');
  if (unbindMenuButton) unbindMenuButton.disabled = !isBound;
  document.getElementById('unbound').style.display = isBound ? 'none' : 'grid';
  document.getElementById('bound').style.display = isBound ? 'flex' : 'none';
  if (!LOCAL_AUTH_SCAN_ENABLED) {
    const authScanButton = document.getElementById('authScanButton');
    if (authScanButton) authScanButton.style.display = 'none';
  }
  renderDynamicMeta();
  if (isBound) ensureClaudeOAuthStart().catch((error) => setToast('oauthResult', error.message, 'error'));
  if (isBound && autoScan) runBoundPageAuthScan(true).catch(() => undefined);
  if (!isBound && statusState.binding?.serverStatus === 'invalid')
    setToast('unboundResult', t('nodeBindingExpired'), 'error');
  if (isBound && statusState.binding?.serverNodeStatus === 'paused')
    setToast('boundResult', t('nodePausedNotice'), 'warn');
}

async function refreshStatusFromAction() {
  const toastId = statusState?.binding?.isBound ? 'boundResult' : 'unboundResult';
  setToast(toastId, t('refreshingNodeStatus'));
  try {
    await refreshStatus();
    setToast(statusState?.binding?.isBound ? 'boundResult' : 'unboundResult', t('nodeStatusRefreshed'), 'success');
  } catch (error) {
    setToast(toastId, error.message, 'error');
  }
}

async function bindNode() {
  return bindWithCode({
    bindingCode: document.getElementById('bindingCode').value.trim(),
    platformBindUrl: statusState?.binding?.platformBindUrl,
    resultId: 'unboundResult',
  });
}

async function bindWithCode({ bindingCode, platformBindUrl, resultId = 'unboundResult', auto = false }) {
  const button = document.getElementById('bindButton');
  if (!bindingCode) {
    setToast(resultId, t('bindingCodeRequired'), 'error');
    return;
  }
  if (button) button.disabled = true;
  if (auto) setToast(resultId, t('autoBindingStarted'));
  try {
    await api('/api/platform/bind', {
      method: 'POST',
      body: JSON.stringify({ bindingCode, platformBindUrl }),
    });
    await refreshStatus(false);
    if (statusState?.binding?.isBound) await runBoundPageAuthScan(false);
    clearLaunchBindingParams();
  } catch (error) {
    if (auto && isInvalidBindingCodeError(error)) clearLaunchBindingParams();
    setToast(resultId, formatApiError(error), 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

function parseLaunchBindingParams() {
  const raw = location.hash && location.hash.length > 1 ? location.hash.slice(1) : location.search.slice(1);
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const bindingCode = params.get('bindingCode') || params.get('code');
  if (!bindingCode) return null;
  return {
    bindingCode,
    platformBindUrl: params.get('platformBindUrl') || undefined,
  };
}

function clearLaunchBindingParams() {
  if (location.hash || location.search || location.pathname === '/bind') {
    history.replaceState(null, '', location.pathname === '/bind' ? '/' : location.pathname || '/');
  }
}

function isInvalidBindingCodeError(error) {
  return error?.message === 'invalid_binding_code' || error?.body?.error?.code === 'invalid_binding_code';
}

async function consumeLaunchBindingParams() {
  const launch = parseLaunchBindingParams();
  if (!launch) return;
  // Status is loaded before the normal initial consume. Ignore early focus/
  // visibility events until then so they cannot race the status request.
  if (!statusState) return;
  // A stale one-click binding URL can be reopened or refreshed long after this
  // node was bound. Do not rotate its secret or repeatedly redeem the old code.
  if (statusState.binding?.isBound) {
    clearLaunchBindingParams();
    return;
  }
  const launchKey = launch.bindingCode + '|' + (launch.platformBindUrl || '');
  if (launchKey === consumedLaunchBindingKey) return;
  if (launchBindingInFlight) return launchBindingInFlight;
  consumedLaunchBindingKey = launchKey;
  document.getElementById('bindingCode').value = launch.bindingCode;
  launchBindingInFlight = bindWithCode({
    bindingCode: launch.bindingCode,
    platformBindUrl: launch.platformBindUrl || statusState?.binding?.platformBindUrl,
    auto: true,
  }).finally(() => {
    launchBindingInFlight = null;
  });
  await launchBindingInFlight;
}

function consumeLaunchBindingParamsSoon() {
  setTimeout(() => {
    consumeLaunchBindingParams().catch((error) => showMessage(error.message));
  }, 0);
}

async function unbindNode() {
  if (
    !(await nodeConfirm(t('unbindConfirm'), {
      title: locale === 'zh' ? '确认解绑' : 'Confirm Unbind',
      confirmLabel: locale === 'zh' ? '解绑' : 'Unbind',
      tone: 'danger',
    }))
  )
    return;
  await api('/api/platform/unbind', { method: 'POST', body: '{}' });
  await refreshStatus();
}

async function unbindNodeFromMenu(event) {
  event?.preventDefault();
  event?.stopPropagation();
  closeTopMenus();
  await unbindNode();
}

async function requestUninstallNode(event) {
  event?.preventDefault();
  event?.stopPropagation();
  closeTopMenus();
  const confirmation = await nodeUninstallConfirm();
  if (!confirmation) return;
  try {
    const result = await api('/api/system/uninstall/start', {
      method: 'POST',
      body: JSON.stringify(confirmation),
    });
    const message = result.command
      ? t('uninstallCommandFallback') + result.command
      : t('uninstallStarted');
    setToast(statusState?.binding?.isBound ? 'boundResult' : 'unboundResult', message, result.command ? undefined : 'success');
  } catch (error) {
    setToast(statusState?.binding?.isBound ? 'boundResult' : 'unboundResult', formatApiError(error), 'error');
  }
}

async function loadCredentials(silent = false) {
  try {
    const local = LOCAL_AUTH_SCAN_ENABLED ? await api('/api/oauth/local/detect') : { data: [] };
    const candidates = Array.isArray(local.data) ? local.data : [];
    const binding = await refreshPlatformBindingStatus();
    // A paused node is still bound, but the Platform credential endpoints only serve active
    // nodes — skip the fetch so we show the paused notice instead of a credential error.
    const isServingBound = binding?.server?.status === 'bound' && binding?.server?.nodeStatus !== 'paused';
    const platform = isServingBound ? await api('/api/platform/credentials') : { data: [] };
    const credentials = Array.isArray(platform.data) ? platform.data : [];
    platformCredentials = credentials.filter((credential) => credential.status !== 'revoked');
    localCredentialCandidates = candidates;
    renderCredentialGrid(platformCredentials, candidates);
    if (!silent && binding?.server?.status === 'invalid')
      setToast('credentialResult', t('nodeBindingExpired'), 'error');
    if (!silent && binding?.server?.nodeStatus === 'paused')
      setToast('credentialResult', t('nodePausedNotice'), 'warn');
    if (!silent && binding?.server?.status === 'unavailable')
      setToast(
        'credentialResult',
        t('nodeBindingUnavailable') + (binding.server.error ? ' ' + binding.server.error : ''),
        'error',
      );
  } catch (error) {
    platformCredentials = [];
    localCredentialCandidates = [];
    renderCredentialGrid([], []);
    if (silent) return;
    setToast('credentialResult', t('couldNotLoadCredentials') + formatApiError(error), 'error');
  }
}

async function rescanCredentials() {
  await runBoundPageAuthScan(false);
}

async function runBoundPageAuthScan(silent = false) {
  if (authScanInFlight) return authScanInFlight;
  setAuthScanButtonLoading(true);
  authScanInFlight = loadCredentials(silent).finally(() => {
    lastCredentialScanAt = new Date().toISOString();
    authScanInFlight = null;
    setAuthScanButtonLoading(false);
  });
  return authScanInFlight;
}

async function refreshPlatformBindingStatus() {
  const binding = await apiWithTimeout('/api/platform/binding-status', {}, 5000);
  statusState.binding = {
    ...(statusState.binding || {}),
    localIsBound: Boolean(binding.local?.isBound),
    isBound:
      binding.server?.status === 'invalid' || binding.server?.status === 'unbound'
        ? false
        : Boolean(binding.local?.isBound),
    serverStatus: binding.server?.status,
    serverNodeStatus: binding.server?.nodeStatus,
    serverProviderId: binding.server?.providerId,
    serverNodeId: binding.server?.nodeId,
    serverLastSeenAt: binding.server?.lastSeenAt,
  };
  if (binding.server?.providerId) statusState.config.providerId = binding.server.providerId;
  if (binding.server?.nodeId) statusState.config.nodeId = binding.server.nodeId;
  platformCredentials = [];
  return binding;
}

function setAuthScanButtonLoading(loading) {
  const button = document.getElementById('authScanButton');
  if (!button) return;
  button.disabled = loading;
  button.textContent = loading ? t('scanningAuthButton') : t('scanAgain');
}

function renderEmptyCredentials() {
  document.getElementById('credentialGrid').innerHTML =
    '<div class="credential-empty"><strong>' +
    escapeHtml(t('noCredentialsTitle')) +
    '</strong><span>' +
    escapeHtml(t('noCredentialsBody')) +
    '</span></div>';
}

function renderCredentialGrid(credentials, candidates) {
  const visibleLocal = compactLocalCredentialsForDisplay(
    candidates.filter(
      (item) =>
        item.status === 'ready' ||
        item.status === 'requires_authorization' ||
        item.status === 'error' ||
        item.reason === 'claude_code_local_oauth_import_not_supported',
    ),
    credentials,
  );
  const unmatchedCredentials = credentials.filter(
    (credential) =>
      !visibleLocal.some((item) => credentialMatchesLocalCredential(credential, item, { requireActive: false })),
  );
  renderManualCredentialImportVisibility(candidates);
  if (!unmatchedCredentials.length && !visibleLocal.length) {
    renderEmptyCredentials();
    return;
  }
  document.getElementById('credentialGrid').innerHTML =
    renderLocalCredentialCards(visibleLocal) + renderPlatformCredentialCards(unmatchedCredentials);
}

function compactLocalCredentialsForDisplay(candidates, credentials) {
  const result = [];
  const activeCredentialSources = new Map();
  for (const item of candidates) {
    const activeCredential = credentials.find((credential) => credentialMatchesLocalCredential(credential, item));
    const credentialId = activeCredential?.credentialBindingId;
    if (!credentialId) {
      result.push(item);
      continue;
    }
    const existingIndex = activeCredentialSources.get(credentialId);
    if (existingIndex === undefined) {
      activeCredentialSources.set(credentialId, result.length);
      result.push(item);
      continue;
    }
    const existing = result[existingIndex];
    if (localCredentialDisplayPriority(item) > localCredentialDisplayPriority(existing)) {
      result[existingIndex] = item;
    }
  }
  return result;
}

function localCredentialDisplayPriority(item) {
  if (item.source === 'claude-code') return 30;
  if (item.source === 'codex-auth-json') return 30;
  if (item.path) return 20;
  return 0;
}

function renderManualCredentialImportVisibility(candidates = localCredentialCandidates || []) {}

function renderPlatformCredentials(credentials) {
  document.getElementById('credentialGrid').innerHTML = renderPlatformCredentialCards(credentials);
}

function platformCredentialCardTitle(item) {
  if (item.vendor === 'openai') return t('codexAuthJsonLabel');
  if (item.vendor === 'anthropic') return t('claudeCodeSessionLabel');
  return vendorLabel(item.vendor);
}

function renderPlatformCredentialCards(credentials) {
  const statusKey = { active: 'boundBadge', paused: 'pausedBadge', revoked: 'revokedBadge', disabled: 'disabledBadge' };
  const statusClass = { active: 'ok', paused: 'warn', revoked: 'warn', disabled: 'warn' };
  return compactPlatformCredentialsForDisplay(credentials)
    .map(
      (item) =>
        '<article class="credential-card"><div class="cred-head"><div class="cred-name"><div><h3>' +
        escapeHtml(platformCredentialCardTitle(item)) +
        '</h3></div></div><span class="badge ' +
        escapeHtml(statusClass[item.status] || 'warn') +
        '">' +
        escapeHtml(platformCredentialBadgeLabel(item, statusKey)) +
        '</span></div><div class="details"><div><span>' +
        escapeHtml(t(item.revokedCount ? 'credentialIdsLabel' : 'credentialIdLabel')) +
        '</span><strong>' +
        escapeHtml(
          item.revokedCount ? compactCredentialIds(item.credentialBindingIds) : shortId(item.credentialBindingId),
        ) +
        '</strong></div>' +
        (item.revokedCount
          ? '<div><span>' +
            escapeHtml(t('recordCountLabel')) +
            '</span><strong>' +
            escapeHtml(String(item.revokedCount)) +
            '</strong></div>'
          : '') +
        '<div><span>' +
        escapeHtml(t('pathLabel')) +
        '</span><strong>/</strong></div>' +
        (item.accountEmail
          ? '<div><span>' +
            escapeHtml(t('accountLabel')) +
            '</span><strong>' +
            escapeHtml(item.accountEmail) +
            '</strong></div>'
          : '') +
        (item.subscriptionType
          ? '<div><span>' +
            escapeHtml(t('subscriptionTypeLabel')) +
            '</span><strong>' +
            escapeHtml(item.subscriptionDisplayName || item.subscriptionType) +
            '</strong></div>'
          : '') +
        '<div><span>' +
        escapeHtml(t('statusUpdatedLabel')) +
        '</span><strong>' +
        escapeHtml(dateLabel(item.updatedAt || item.createdAt)) +
        '</strong></div>' +
        (item.cooldownUntil
          ? '<div><span>' +
            escapeHtml(t('cooldownUntilLabel')) +
            '</span><strong>' +
            escapeHtml(dateLabel(item.cooldownUntil)) +
            '</strong></div>'
          : '') +
        (item.lastErrorCode
          ? '<div><span>' +
            escapeHtml(t('errorCodeLabel')) +
            '</span><strong>' +
            escapeHtml(item.lastErrorCode) +
            '</strong></div>'
          : '') +
        '</div></article>',
    )
    .join('');
}

function compactPlatformCredentialsForDisplay(credentials) {
  const result = [];
  const revokedGroups = new Map();
  for (const credential of credentials) {
    if (credential.status !== 'revoked') {
      result.push(credential);
      continue;
    }
    const key = revokedCredentialGroupKey(credential);
    const group = revokedGroups.get(key);
    if (!group) {
      const first = {
        ...credential,
        revokedCount: 1,
        credentialBindingIds: [credential.credentialBindingId].filter(Boolean),
      };
      revokedGroups.set(key, first);
      result.push(first);
      continue;
    }
    group.revokedCount += 1;
    if (credential.credentialBindingId) group.credentialBindingIds.push(credential.credentialBindingId);
    if (!group.accountEmail && credential.accountEmail) group.accountEmail = credential.accountEmail;
    if (!group.organizationId && credential.organizationId) group.organizationId = credential.organizationId;
    if (!group.subscriptionType && credential.subscriptionType) group.subscriptionType = credential.subscriptionType;
    if (!group.subscriptionDisplayName && credential.subscriptionDisplayName)
      group.subscriptionDisplayName = credential.subscriptionDisplayName;
    if (
      !group.lastUsedAt ||
      (credential.lastUsedAt && Date.parse(credential.lastUsedAt) > Date.parse(group.lastUsedAt))
    )
      group.lastUsedAt = credential.lastUsedAt;
    if (credential.updatedAt && (!group.updatedAt || Date.parse(credential.updatedAt) > Date.parse(group.updatedAt))) {
      group.updatedAt = credential.updatedAt;
      group.createdAt = credential.createdAt || group.createdAt;
    }
  }
  return result;
}

function revokedCredentialGroupKey(credential) {
  const identity = credentialIdentityKey(credential);
  const subscription = normalizedIdentityValue(credential.subscriptionType || credential.subscriptionDisplayName);
  return [credential.vendor || 'unknown', identity || 'legacy', subscription || 'unknown'].join(':');
}

function platformCredentialBadgeLabel(item, statusKey) {
  const base = t(statusKey[item.status] || 'needsAttention');
  return item.revokedCount && item.revokedCount > 1 ? base + ' x' + item.revokedCount : base;
}

function compactCredentialIds(ids) {
  const values = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!values.length) return '';
  return values.length <= 4
    ? values.map(shortId).join(', ')
    : values.slice(0, 3).map(shortId).join(', ') + ' +' + (values.length - 3);
}

function renderLocalCredentialCards(candidates) {
  return candidates
    .map((item) => {
      const index = localCredentialCandidates.indexOf(item);
      const ready = item.status === 'ready';
      const needsAuthorization = item.status === 'requires_authorization';
      const activeCredential = matchingPlatformCredential(item);
      const matchedCredential = activeCredential || matchingPlatformCredential(item, { requireActive: false });
      const authorized = Boolean(activeCredential);
      const authStatus = localCredentialAuthorizationStatus(item, authorized, matchedCredential);
      const showReason = item.reason && !authorized && item.reason !== 'claude_code_credentials_authorization_required';
      const authButtonLabel =
        matchedCredential && matchedCredential.status !== 'active'
          ? t('reauthorizeLocalCredential')
          : t('importLocalCredential');
      return (
        '<article class="credential-card"><div class="cred-head"><div class="cred-name"><div><h3>' +
        escapeHtml(localCredentialLabel(item)) +
        '</h3></div></div><span class="badge ' +
        escapeHtml(authStatus.className) +
        '">' +
        escapeHtml(t(authStatus.labelKey)) +
        '</span></div><div class="details">' +
        (matchedCredential
          ? '<div><span>' +
            escapeHtml(t('credentialIdLabel')) +
            '</span><strong>' +
            escapeHtml(shortId(matchedCredential.credentialBindingId)) +
            '</strong></div>'
          : '') +
        (item.path
          ? '<div><span>' +
            escapeHtml(t('pathLabel')) +
            '</span><strong title="' +
            escapeHtml(item.path) +
            '">' +
            escapeHtml(shortPath(item.path)) +
            '</strong></div>'
          : '') +
        (item.accountEmail
          ? '<div><span>' +
            escapeHtml(t('accountLabel')) +
            '</span><strong>' +
            escapeHtml(item.accountEmail) +
            '</strong></div>'
          : '') +
        (item.subscriptionType
          ? '<div><span>' +
            escapeHtml(t('subscriptionTypeLabel')) +
            '</span><strong>' +
            escapeHtml(item.subscriptionDisplayName || item.subscriptionType) +
            '</strong></div>'
          : '') +
        (matchedCredential?.updatedAt
          ? '<div><span>' +
            escapeHtml(t('statusUpdatedLabel')) +
            '</span><strong>' +
            escapeHtml(dateLabel(matchedCredential.updatedAt)) +
            '</strong></div>'
          : '') +
        (matchedCredential?.lastErrorCode && !authorized
          ? '<div><span>' +
            escapeHtml(t('errorCodeLabel')) +
            '</span><strong>' +
            escapeHtml(matchedCredential.lastErrorCode) +
            '</strong></div>'
          : '') +
        (showReason
          ? '<div><span>' +
            escapeHtml(t('reasonLabel')) +
            '</span><strong>' +
            escapeHtml(localCredentialReason(item.reason)) +
            '</strong></div>'
          : '') +
        '</div>' +
        (!authorized && ready
          ? '<button class="secondary-btn" id="localCredentialButton' +
            index +
            '" onclick="importDetectedCredential(' +
            index +
            ')">' +
            escapeHtml(authButtonLabel) +
            '</button>'
          : '') +
        (!authorized && needsAuthorization
          ? '<button class="secondary-btn" id="localCredentialButton' +
            index +
            '" onclick="authorizeDetectedCredential(' +
            index +
            ')">' +
            escapeHtml(authButtonLabel) +
            '</button>'
          : '') +
        '</article>'
      );
    })
    .join('');
}

function matchingPlatformCredential(item, options) {
  return (platformCredentials || []).find((credential) => credentialMatchesLocalCredential(credential, item, options));
}

function credentialMatchesLocalCredential(credential, item, options = {}) {
  const requireActive = options.requireActive !== false;
  if (requireActive && credential.status !== 'active') return false;
  if (credential.vendor !== item.vendor) return false;
  return credentialMatchesLocalIdentity(credential, item);
}

function credentialMatchesLocalIdentity(credential, item) {
  const credentialClaudeAccount = normalizedIdentityValue(credential?.claudeCodeAccountUuid);
  const localClaudeAccount = normalizedIdentityValue(item?.claudeCodeAccountUuid);
  if (credentialClaudeAccount && localClaudeAccount) return credentialClaudeAccount === localClaudeAccount;

  const credentialOrganization = normalizedIdentityValue(credential?.organizationId);
  const localOrganization = normalizedIdentityValue(item?.organizationId);
  if (credentialOrganization && localOrganization) return credentialOrganization === localOrganization;

  const credentialEmail = normalizedIdentityValue(credential?.accountEmail);
  const localEmail = normalizedIdentityValue(item?.accountEmail);
  if (credentialEmail && localEmail) return credentialEmail === localEmail;

  return !credentialIdentityKey(credential) && !credentialIdentityKey(item);
}

function credentialIdentityKey(value) {
  const claudeCodeAccountUuid = normalizedIdentityValue(value?.claudeCodeAccountUuid);
  if (claudeCodeAccountUuid) return 'claude:' + claudeCodeAccountUuid;
  const organizationId = normalizedIdentityValue(value?.organizationId);
  if (organizationId) return 'org:' + organizationId;
  const accountEmail = normalizedIdentityValue(value?.accountEmail);
  if (accountEmail) return 'email:' + accountEmail;
  return '';
}

function normalizedIdentityValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
}

function localCredentialAuthorizationStatus(item, authorized, matchedCredential) {
  if (authorized) return { labelKey: 'localCredentialAuthorized', className: 'ok' };
  if (matchedCredential?.status === 'disabled') return { labelKey: 'disabledBadge', className: 'warn' };
  if (matchedCredential?.status === 'paused') return { labelKey: 'pausedBadge', className: 'warn' };
  if (matchedCredential?.status === 'revoked') return { labelKey: 'revokedBadge', className: 'warn' };
  if (item.status === 'requires_authorization')
    return { labelKey: 'localCredentialPendingAuthorization', className: 'warn' };
  if (item.status === 'ready') return { labelKey: 'localCredentialReadyToAuthorize', className: 'warn' };
  return { labelKey: 'localCredentialUnavailable', className: 'warn' };
}

function platformCredentialStatusLabel(status) {
  const statusKey = { active: 'boundBadge', paused: 'pausedBadge', revoked: 'revokedBadge', disabled: 'disabledBadge' };
  return t(statusKey[status] || 'needsAttention');
}

function localCredentialLabel(item) {
  if (item.source === 'codex-auth-json') return t('codexAuthJsonLabel');
  if (item.source === 'claude-code') return t('claudeCodeSessionLabel');
  return item.label || vendorLabel(item.vendor);
}

function localCredentialSubtitle(item) {
  return t('detectedLocalCredential');
}

function localCredentialReason(reason) {
  if (reason === 'browser_authorization_required') return t('browserAuthorizationRequired');
  if (reason === 'claude_code_config_not_found') return t('claudeMissingReason');
  if (reason === 'claude_code_credentials_authorization_required') return t('claudeCredentialsAuthorizationReason');
  if (reason === 'claude_code_credentials_not_found') return t('claudeCredentialsMissingReason');
  if (reason === 'claude_code_credentials_missing_tokens') return t('claudeCredentialsMissingTokensReason');
  if (reason === 'codex_auth_json_not_found') return t('codexMissingReason');
  return reason;
}

function shortPath(value) {
  if (!value) return '';
  const home = statusState?.codex?.defaultAuthJsonPath
    ? statusState.codex.defaultAuthJsonPath.replace('/.codex/auth.json', '')
    : '';
  return home && value.startsWith(home) ? '~' + value.slice(home.length) : value;
}

async function importDetectedCredential(index) {
  const item = localCredentialCandidates?.[index];
  if (!item?.canImport) return;
  const matchedCredential = matchingPlatformCredential(item, { requireActive: false });
  const legacyCredential = !matchedCredential ? legacyPlatformCredentialForLocalCredential(item) : null;
  const credentialBindingId =
    matchedCredential && ['disabled', 'paused'].includes(matchedCredential.status)
      ? matchedCredential.credentialBindingId
      : legacyCredential?.credentialBindingId;
  const button = document.getElementById('localCredentialButton' + index);
  const oldText = button?.textContent || '';
  if (button) {
    button.disabled = true;
    button.textContent = t('importingLocalCredential');
  }
  setToast('credentialResult', t('importingLocalCredential'));
  try {
    await api('/api/platform/credentials/authorize-local', {
      method: 'POST',
      body: JSON.stringify({ source: item.source, path: item.path, credentialBindingId }),
    });
    setToast('credentialResult', t('importLocalCredentialDone'), 'success');
    await loadCredentials();
  } catch (error) {
    setToast('credentialResult', formatApiError(error), 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = oldText || t('importLocalCredential');
    }
  }
}

function legacyPlatformCredentialForLocalCredential(item) {
  const normalizedLocalSubscription = normalizedIdentityValue(item?.subscriptionType);
  const candidates = (platformCredentials || []).filter((credential) => {
    if (credential.status === 'revoked') return false;
    if (credential.vendor !== item.vendor) return false;
    if (credentialIdentityKey(credential)) return false;
    const normalizedCredentialSubscription = normalizedIdentityValue(credential.subscriptionType);
    if (
      normalizedLocalSubscription &&
      normalizedCredentialSubscription &&
      normalizedLocalSubscription !== normalizedCredentialSubscription
    )
      return false;
    return true;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function formatApiError(error) {
  const message = error?.body?.error || error?.message || String(error || '');
  if (message === 'Invalid provider node credentials') return t('nodeBindingInvalidCredentials');
  if (message === 'platform_unreachable') return t('platformUnreachable');
  if (message === 'uninstall_confirmation_required') return t('uninstallConfirmRequired');
  if (message === 'anthropic_oauth_start_required') return t('authorizationFlowExpired');
  if (message === 'anthropic_oauth_state_mismatch') return t('authorizationCodeLinkMismatch');
  return message;
}

function showClaudeAuthorizationError(error) {
  const message = formatApiError(error) || t('authorizationSubmitFailed');
  setToast('claudeAuthorizationCodeResult', message, 'error');
  setToast('oauthResult', '');
  document.getElementById('claudeAuthorizationCodeResult')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function authorizeDetectedCredential(index) {
  const item = localCredentialCandidates?.[index];
  if (!item) return;
  if (item.source === 'claude-code') {
    await importDetectedCredential(index);
    return;
  }
}

function vendorLabel(vendor) {
  if (vendor === 'anthropic') return 'Claude';
  if (vendor === 'openai') return 'OpenAI / Codex';
  return vendor || 'OAuth';
}

function selectProvider(provider) {
  activeProvider = provider;
  const labels = { claude: 0, codex: 1, grok: 2 };
  document.querySelectorAll('.provider-option').forEach((item, index) => {
    const selected = index === (labels[provider] || 0);
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  document.getElementById('claudeAuthPanel')?.classList.toggle('hidden', provider !== 'claude');
  document.getElementById('codexAuthPanel')?.classList.toggle('hidden', provider !== 'codex');
  document.getElementById('xaiAuthPanel')?.classList.toggle('hidden', provider !== 'grok');
  if (provider === 'claude') ensureClaudeOAuthStart().catch((error) => setToast('oauthResult', error.message, 'error'));
}

async function startCodexDevice() {
  const currentDeviceCode = activeCodexDeviceCode && Date.now() < activeCodexDeviceCode.expiresAt
    ? activeCodexDeviceCode
    : null;
  if (currentDeviceCode?.userCode && activeDeviceAuthId) {
    const authWindow = openCodexDeviceAuthPlaceholder();
    openCodexDeviceAuthWindow(currentDeviceCode, authWindow);
    setToast('oauthResult', t('deviceCodeOpened'));
    startDevicePolling(currentDeviceCode.interval || 5, { keepCurrentToast: true });
    return;
  }

  stopDevicePolling();
  const authWindow = openCodexDeviceAuthPlaceholder();
  try {
    const data = await api('/api/oauth/codex/device/start', { method: 'POST', body: '{}' });
    activeDeviceAuthId = data.deviceAuthId;
    activeCodexDeviceCode = data;
    document.getElementById('codexDeviceUserCodeLabel').textContent = data.userCode;
    openCodexDeviceAuthWindow(data, authWindow);
    setToast('oauthResult', t('deviceCodeOpened'));
    startDevicePolling(data.interval || 5, { keepCurrentToast: true });
  } catch (error) {
    if (authWindow && !authWindow.closed) authWindow.close();
    setToast('oauthResult', formatApiError(error), 'error');
  }
}

function stopDevicePolling() {
  if (devicePollTimer) clearTimeout(devicePollTimer);
  devicePollTimer = null;
  activeDeviceAuthId = null;
  activeCodexDeviceCode = null;
  activeXaiDeviceCode = null;
  devicePollRunId += 1;
}

function isDeviceAuthNotFound(error) {
  return error?.message === 'device_auth_not_found' || error?.body?.error === 'device_auth_not_found';
}

function isTransientDevicePollError(error) {
  const message = error?.body?.error || error?.message || String(error || '');
  return error?.status >= 500 || message === 'internal_error' || message === 'codex_device_poll_failed';
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_error) {
    return copyTextWithSelection(text);
  }
}

function copyTextWithSelection(text) {
  const node = document.createElement('textarea');
  node.value = text;
  node.setAttribute('readonly', '');
  node.style.position = 'fixed';
  node.style.left = '-9999px';
  node.style.top = '0';
  document.body.appendChild(node);
  node.focus();
  node.select();
  try {
    return document.execCommand('copy');
  } catch (_error) {
    return false;
  } finally {
    node.remove();
  }
}

function selectCodexDeviceCode() {
  const node = document.getElementById('codexDeviceUserCodeLabel');
  if (!node) return;
  const selection = window.getSelection?.();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  node.scrollIntoView({ block: 'nearest' });
}

function openCodexDeviceAuthPlaceholder() {
  const authWindow = window.open('about:blank', 'wokeyCodexDeviceAuth');
  if (!authWindow) return null;
  try {
    const title = locale === 'zh' ? '正在打开 ChatGPT 授权页' : 'Opening ChatGPT authorization';
    const body = locale === 'zh' ? '正在生成设备码，请稍候…' : 'Generating a device code. Please wait...';
    authWindow.document.title = title;
    authWindow.document.body.innerHTML =
      '<main style="font:16px system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;min-height:100vh;display:grid;place-items:center;margin:0;background:#fff;color:#0b1c30"><div style="text-align:center"><h1 style="font-size:20px;margin:0 0 8px">' +
      title +
      '</h1><p style="margin:0;color:#5f6f7f">' +
      body +
      '</p></div></main>';
  } catch (_error) {
    // Some browsers restrict about:blank document writes; navigation below will still work.
  }
  return authWindow;
}

function openCodexDeviceAuthWindow(deviceCode, authWindow) {
  const target = authWindow || window.open('about:blank', 'wokeyCodexDeviceAuth');
  if (!target) return false;
  target.location.href = deviceCode.verificationUrl;
  target.focus();
  return true;
}

function startDevicePolling(intervalSeconds, options = {}) {
  if (devicePollTimer) clearTimeout(devicePollTimer);
  const pollRunId = ++devicePollRunId;
  const intervalMs = Math.max(2, Number(intervalSeconds) || 5) * 1000;
  let transientPollErrors = 0;
  if (!options.keepCurrentToast) setToast('oauthResult', t('deviceWaiting'));

  const finishDevicePolling = () => {
    if (pollRunId !== devicePollRunId) return false;
    if (devicePollTimer) clearTimeout(devicePollTimer);
    devicePollTimer = null;
    activeDeviceAuthId = null;
    activeCodexDeviceCode = null;
    devicePollRunId += 1;
    return true;
  };

  const scheduleNextPoll = () => {
    if (pollRunId !== devicePollRunId || !activeDeviceAuthId) return;
    devicePollTimer = setTimeout(pollOnce, intervalMs);
  };

  const pollOnce = async () => {
    if (pollRunId !== devicePollRunId || !activeDeviceAuthId) return;
    const deviceAuthId = activeDeviceAuthId;
    try {
      const data = await api('/api/oauth/codex/device/poll', {
        method: 'POST',
        body: JSON.stringify({ deviceAuthId }),
      });
      if (pollRunId !== devicePollRunId || deviceAuthId !== activeDeviceAuthId) return;
      transientPollErrors = 0;
      if (data.status === 'pending') {
        scheduleNextPoll();
        return;
      }
      if (data.status === 'expired') {
        if (finishDevicePolling()) setToast('oauthResult', t('deviceAuthorizationExpired'), 'error');
        return;
      }
      if (data.status !== 'succeeded') {
        scheduleNextPoll();
        return;
      }
      if (!finishDevicePolling()) return;
      setToast('oauthResult', t('deviceAuthorized'), 'success');
      await refreshStatus();
    } catch (error) {
      if (pollRunId !== devicePollRunId || deviceAuthId !== activeDeviceAuthId) return;
      if (isDeviceAuthNotFound(error)) {
        if (finishDevicePolling()) setToast('oauthResult', t('deviceAuthorizationExpired'), 'error');
        return;
      }
      if (isTransientDevicePollError(error) && transientPollErrors < 5) {
        transientPollErrors += 1;
        scheduleNextPoll();
        return;
      }
      if (finishDevicePolling()) setToast('oauthResult', formatApiError(error), 'error');
    }
  };

  scheduleNextPoll();
}

async function copyCodexDeviceCode() {
  const code = document.getElementById('codexDeviceUserCodeLabel').textContent.trim();
  if (!code || /^-+$/.test(code)) {
    setToast('oauthResult', t('deviceCodeStartFirst'));
    return;
  }
  const copied = await copyTextToClipboard(code);
  if (!copied) {
    selectCodexDeviceCode();
    setToast('oauthResult', t('deviceCodeCopyBlocked'));
    return;
  }
  setToast('oauthResult', t('deviceCodeCopied'));
}

// ── xAI (Grok) 设备码 —— RFC 8628,直接用 device_code 轮询 token。复用共享轮询计时器/runId。 ──────────
async function startXaiDevice() {
  if (activeXaiDeviceCode && Date.now() < activeXaiDeviceCode.expiresAt) {
    const authWindow = window.open(activeXaiDeviceCode.verificationUrl, 'wokeyXaiDeviceAuth');
    if (authWindow) authWindow.focus();
    setToast('oauthResult', t('deviceCodeOpened'));
    startXaiDevicePolling(activeXaiDeviceCode);
    return;
  }
  stopDevicePolling();
  const authWindow = window.open('about:blank', 'wokeyXaiDeviceAuth');
  try {
    const data = await api('/api/oauth/xai/device/start', { method: 'POST', body: '{}' });
    activeXaiDeviceCode = data;
    document.getElementById('xaiDeviceUserCodeLabel').textContent = data.userCode;
    if (authWindow) { authWindow.location.href = data.verificationUrl; authWindow.focus(); }
    setToast('oauthResult', t('deviceCodeOpened'));
    startXaiDevicePolling(data);
  } catch (error) {
    if (authWindow && !authWindow.closed) authWindow.close();
    setToast('oauthResult', formatApiError(error), 'error');
  }
}

function startXaiDevicePolling(deviceCode) {
  if (devicePollTimer) clearTimeout(devicePollTimer);
  const pollRunId = ++devicePollRunId;
  const intervalMs = Math.max(2, Number(deviceCode.interval) || 5) * 1000;
  let transientPollErrors = 0;
  setToast('oauthResult', t('deviceWaiting'));

  const finish = () => {
    if (pollRunId !== devicePollRunId) return false;
    if (devicePollTimer) clearTimeout(devicePollTimer);
    devicePollTimer = null;
    activeXaiDeviceCode = null;
    devicePollRunId += 1;
    return true;
  };
  const schedule = () => {
    if (pollRunId !== devicePollRunId || !activeXaiDeviceCode) return;
    devicePollTimer = setTimeout(pollOnce, intervalMs);
  };
  const pollOnce = async () => {
    if (pollRunId !== devicePollRunId || !activeXaiDeviceCode) return;
    const dc = activeXaiDeviceCode.deviceCode;
    try {
      const data = await api('/api/oauth/xai/device/poll', { method: 'POST', body: JSON.stringify({ deviceCode: dc }) });
      if (pollRunId !== devicePollRunId) return;
      transientPollErrors = 0;
      if (data.status === 'pending') { schedule(); return; }
      if (data.status === 'expired') { if (finish()) setToast('oauthResult', t('deviceAuthorizationExpired'), 'error'); return; }
      if (data.status !== 'succeeded') { schedule(); return; }
      if (!finish()) return;
      setToast('oauthResult', t('deviceAuthorized'), 'success');
      await refreshStatus();
    } catch (error) {
      if (pollRunId !== devicePollRunId) return;
      if (error?.status >= 500 && transientPollErrors < 5) { transientPollErrors += 1; schedule(); return; }
      if (finish()) setToast('oauthResult', formatApiError(error), 'error');
    }
  };
  schedule();
}

async function copyXaiDeviceCode() {
  const code = document.getElementById('xaiDeviceUserCodeLabel').textContent.trim();
  if (!code || /^-+$/.test(code)) {
    setToast('oauthResult', t('deviceCodeStartFirst'));
    return;
  }
  const copied = await copyTextToClipboard(code);
  if (!copied) {
    setToast('oauthResult', t('deviceCodeCopyBlocked'));
    return;
  }
  setToast('oauthResult', t('deviceCodeCopied'));
}

async function ensureClaudeOAuthStart() {
  if (activeClaudeOAuth?.authorizationUrl) return activeClaudeOAuth;
  const data = await api('/api/oauth/anthropic/start', { method: 'POST', body: '{}' });
  activeClaudeOAuth = data;
  return data;
}

async function startClaudeOAuth() {
  try {
    const data = await ensureClaudeOAuthStart();
    window.open(data.authorizationUrl, '_blank', 'noopener,noreferrer');
    setToast('oauthResult', t('authorizationUrlGenerated'));
  } catch (error) {
    setToast('oauthResult', error.message, 'error');
  }
}

async function copyClaudeAuthorizationLink() {
  try {
    const data = await ensureClaudeOAuthStart();
    await navigator.clipboard.writeText(data.authorizationUrl);
    setToast('oauthResult', t('authorizationLinkCopied'));
  } catch (error) {
    setToast('oauthResult', error.message, 'error');
  }
}

function parseAuthorizationCodeInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') || (url.hash ? decodeURIComponent(url.hash.slice(1)) : null);
    return code ? { code, state } : { code: raw };
  } catch (_error) {
    const paramsText = raw.startsWith('?') ? raw.slice(1) : raw;
    const params = new URLSearchParams(paramsText);
    const code = params.get('code');
    const state = params.get('state');
    if (code) return { code, state };
  }
  const [code, state] = raw.split('#', 2);
  return { code, state };
}

function parseManualOAuthTokenInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let source = null;
  let root = null;
  try {
    const parsed = JSON.parse(raw);
    root = parsed;
    source = parsed.oauth || parsed.token || parsed.tokens || parsed.claudeAiOauth || parsed;
  } catch (_error) {
    if (raw.includes('=') && (raw.includes('access_token') || raw.includes('accessToken'))) {
      const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
      source = Object.fromEntries(params.entries());
    }
  }
  if (!source) {
    return { accessToken: raw.replace(/^bearer\s+/i, ''), tokenType: 'Bearer' };
  }
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
    organizationId:
      source.organizationId ||
      source.organization_id ||
      source.organization?.uuid ||
      oauthAccount.organizationUuid ||
      oauthAccount.accountUuid ||
      authClaims.chatgpt_account_id ||
      source.account_id,
    accountEmail:
      source.accountEmail || source.account_email || source.account?.email_address || oauthAccount.emailAddress,
    subscriptionType:
      source.subscriptionType ||
      source.subscription_type ||
      source.chatgptPlanType ||
      source.chatgpt_plan_type ||
      authClaims.chatgpt_plan_type,
    subscriptionDisplayName: source.subscriptionDisplayName || source.subscription_display_name,
    rateLimitTier: source.rateLimitTier || root?.rateLimitTier,
    organizationRateLimitTier: source.organizationRateLimitTier || oauthAccount.organizationRateLimitTier,
    userRateLimitTier: source.userRateLimitTier || oauthAccount.userRateLimitTier,
    organizationType: source.organizationType || oauthAccount.organizationType,
    claudeCodeUserId: source.claudeCodeUserId || source.claude_code_user_id || root?.userID,
    claudeCodeAccountUuid: source.claudeCodeAccountUuid || source.claude_code_account_uuid || oauthAccount.accountUuid,
  };
}

async function submitManualOAuthToken() {
  try {
    const parsed = parseManualOAuthTokenInput(document.getElementById('manualOAuthTokenInput')?.value);
    if (!parsed) {
      setToast('oauthResult', t('oauthTokenRequired'), 'error');
      return;
    }
    if (!parsed.accessToken) {
      setToast('oauthResult', t('oauthAccessTokenRequired'), 'error');
      return;
    }
    if (activeProvider === 'codex' && !parsed.refreshToken) {
      setToast('oauthResult', t('oauthRefreshTokenRequired'), 'error');
      return;
    }
    await api('/api/platform/credentials/authorize-token', {
      method: 'POST',
      body: JSON.stringify({
        ...parsed,
        vendor: activeProvider === 'claude' ? 'anthropic' : 'openai',
      }),
    });
    document.getElementById('manualOAuthTokenInput').value = '';
    setToast('oauthResult', t('oauthTokenImported'), 'success');
    await loadCredentials();
  } catch (error) {
    setToast('oauthResult', error.message, 'error');
  }
}

async function submitClaudeAuthorizationCode() {
  const submitButton = document.getElementById('claudeAuthorizationSubmitButton');
  try {
    const flow = activeClaudeOAuth;
    if (!flow?.state) {
      setToast('claudeAuthorizationCodeResult', t('authorizationLinkRequired'), 'error');
      setToast('oauthResult', '');
      return;
    }
    const parsed = parseAuthorizationCodeInput(document.getElementById('claudeAuthorizationCodeInput')?.value);
    if (!parsed?.code) {
      setToast('claudeAuthorizationCodeResult', t('authorizationCodeRequired'), 'error');
      setToast('oauthResult', '');
      return;
    }
    if (submitButton) submitButton.disabled = true;
    setToast('claudeAuthorizationCodeResult', '');
    setToast('oauthResult', '');
    const state = parsed.state || flow.state;
    const code = parsed.state && !parsed.code.includes('#') ? parsed.code + '#' + parsed.state : parsed.code;
    await api('/api/oauth/anthropic/exchange', {
      method: 'POST',
      body: JSON.stringify({ code, state, flowState: flow.state }),
    });
    activeProvider = 'claude';
    setToast('claudeAuthorizationCodeResult', t('credentialAuthorized'), 'success');
    setToast('oauthResult', '');
    await refreshStatus();
  } catch (error) {
    showClaudeAuthorizationError(error);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

function escapeHtml(value) {
  value = String(value ?? '');
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

Object.assign(window, {
  authorizeDetectedCredential,
  bindNode,
  copyClaudeAuthorizationLink,
  copyCodexDeviceCode,
  copyXaiDeviceCode,
  importDetectedCredential,
  refreshStatusFromAction,
  requestUninstallNode,
  rescanCredentials,
  selectProvider,
  setLocale,
  showBindingHelp,
  startClaudeOAuth,
  startCodexDevice,
  startXaiDevice,
  submitClaudeAuthorizationCode,
  submitManualOAuthToken,
  toggleSettingsMenu,
  toggleLanguageMenu,
  toggleTheme,
  unbindNode,
  unbindNodeFromMenu,
});

document.addEventListener('click', closeTopMenus);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeTopMenus();
});
window.addEventListener('hashchange', consumeLaunchBindingParamsSoon);
window.addEventListener('pageshow', consumeLaunchBindingParamsSoon);
window.addEventListener('focus', consumeLaunchBindingParamsSoon);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) consumeLaunchBindingParamsSoon();
});
applyLocale();
syncThemeToggle();
refreshStatus()
  .then(() => consumeLaunchBindingParams())
  .catch((error) => showMessage(error.message));
