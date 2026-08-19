'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CHANNELS = new Set([
  'app:recents', 'app:removeRecent', 'app:clearRecents', 'app:paths', 'app:zoom',
  'app:menuState', 'app:ready', 'app:about', 'app:log', 'app:clearLog',
  'term:run', 'term:kill',
  'repos:list', 'repos:favorite', 'repos:forget', 'repos:scan', 'repos:wip',
  'git:identity', 'git:setIdentity',
  'flow:config', 'flow:init', 'flow:start', 'flow:finish',
  'repo:pick', 'repo:open', 'repo:clone', 'repo:init', 'repo:pickDirectory',
  'repo:openTerminal',
  'repo:status', 'repo:log', 'repo:refs', 'repo:remotes',
  'repo:diffFile', 'repo:diffCommit', 'repo:diffCommitFile', 'repo:commitFiles',
  'repo:rewordCommit', 'repo:descendantCount',
  'repo:stage', 'repo:unstage', 'repo:stageAll', 'repo:unstageAll',
  'repo:discard', 'repo:applyPatch',
  'repo:commit', 'repo:lastMessage',
  'repo:checkout', 'repo:checkoutWith', 'repo:createBranch', 'repo:deleteBranch',
  'repo:renameBranch', 'repo:setUpstream', 'repo:fastForward', 'repo:fetchInto',
  'repo:pushBranch', 'repo:deleteRemoteBranch', 'repo:deleteTag', 'repo:compare', 'repo:setRemoteUrl', 'repo:remoteHasBranch',
  'update:check', 'update:download', 'update:install',
  'repo:description', 'repo:setDescription',
  'repo:merge', 'repo:mergeInfo', 'repo:rebase', 'repo:reset', 'repo:revert',
  'repo:cherryPick', 'repo:tag',
  'repo:fetch', 'repo:pull', 'repo:push',
  'repo:stashList', 'repo:stashSave', 'repo:stashApply', 'repo:stashDrop',
  'repo:raw',
  'shell:openPath', 'shell:openExternal', 'shell:openInEditor',
  'git:option', 'git:setOption', 'repos:existing',
  'repo:state', 'repo:abort', 'repo:continue', 'repo:resolve', 'repo:conflictFile',
]);

/* Main-to-renderer pushes. Kept separate from CHANNELS: nothing here may be
   invoked, and nothing there may be subscribed to. */
const EVENTS = new Set(['repo:progress', 'menu:action', 'term:out', 'term:exit',
  'update:progress']);

contextBridge.exposeInMainWorld('gitbraid', {
  invoke(channel, ...args) {
    if (!CHANNELS.has(channel)) {
      return Promise.resolve({ ok: false, error: `Blocked channel: ${channel}` });
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  /** Subscribe to a push channel. Returns an unsubscribe function. */
  on(channel, listener) {
    if (!EVENTS.has(channel)) return () => {};
    const wrapped = (_evt, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  },

  /** Absolute path of a dropped File — `File.path` is gone in newer Electron. */
  pathForFile(file) {
    try {
      return webUtils?.getPathForFile ? webUtils.getPathForFile(file) : (file.path || '');
    } catch {
      return file.path || '';
    }
  },

  platform: process.platform,
});
