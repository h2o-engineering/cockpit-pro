#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';

const P = {
  workspace: 'src-surfaces-base/studio/S0F1b. 🎬 Library Workspace - Studio.js',
  index: 'src-surfaces-base/studio/S0F1c. 🎬 Library Index - Studio.js',
  insights: 'src-surfaces-base/studio/S0F1d. 🎬 Library Insights - Studio.js',
  services: 'src-surfaces-base/studio/S0F1k. 🎬 Library Canonical Services - Studio.js',
  tags: 'src-surfaces-base/studio/S0F5a. 🎬 Tags - Studio.js',
  title: 'src-surfaces-base/studio/S9D1a. 🎬 Auto Emoji Title - Studio.js',
  host: 'src-surfaces-base/studio/platform/index.js',
  mv3: 'src-surfaces-base/studio/platform/platform.mv3.js',
};
const src = Object.fromEntries(Object.entries(P).map(([k,p]) => [k, fs.readFileSync(p,'utf8')]));
let checks = 0;
function check(value, message) { checks += 1; assert.equal(!!value, true, message); }
function between(text, start, end) {
  const a = text.indexOf(start); check(a >= 0, `start marker missing: ${start}`);
  const b = text.indexOf(end, a + start.length); check(b > a, `end marker missing: ${end}`);
  return text.slice(a, b);
}

const c1Index = between(src.index, '  function callArchiveExportFullBundle() {', '\n\n  function ');
const c1Insights = between(src.insights, '  function callArchiveMetadataFetch(url) {', '\n\n  function ');
const c1Services = between(src.services, '  function sendRuntimeArchiveMessage(op = STORAGE_BACKGROUND_DIAG_OP, payload = {}) {', '\n\n  function ');

for (const [name, block] of [['S0F1c',c1Index],['S0F1d',c1Insights],['S0F1k',c1Services]]) {
  check(block.includes('.platform?.messaging') || block.includes('.platform?.messaging?') || block.includes('platform?.messaging'), `${name} must resolve platform messaging`);
  check(block.includes('.send('), `${name} must use messaging.send`);
  check(!block.includes('chrome.runtime.sendMessage') && !block.includes('W.chrome.runtime.sendMessage'), `${name} direct runtime sendMessage remains`);
}
check(c1Index.includes("type: ARCHIVE_MESSAGE_TYPE") && c1Index.includes("op: 'exportFullBundle'") && c1Index.includes('payload: {}'), 'S0F1c archive envelope changed');
check(c1Index.includes('response && response.ok ? response.result : null'), 'S0F1c success projection changed');
check(c1Index.includes('.catch(() => resolve(null))'), 'S0F1c failure projection changed');
check(c1Insights.includes("type: 'h2o-ext-archive:v1'") && c1Insights.includes("op: 'fetchPageMetadata'") && c1Insights.includes('payload: { url }'), 'S0F1d metadata envelope changed');
check(c1Insights.includes('response && response.ok ? response.result : null'), 'S0F1d success projection changed');
check(c1Insights.includes('.catch(() => resolve(null))'), 'S0F1d failure projection changed');
check(c1Services.includes('type: STORAGE_ARCHIVE_MSG') && c1Services.includes("op: String(op || '')") && c1Services.includes("payload: payload && typeof payload === 'object' ? payload : {}"), 'S0F1k archive envelope changed');

const wsSave = between(src.workspace, '  function saveLayout(patch) {', '\n\n  // ── Model fetchers');
const insightSave = between(src.insights, '  function savePrefs(p) {', '\n\n  const prefs = loadPrefs();');
const tagSave = between(src.tags, '  function savePrefs(p) {', '\n\n  const prefs = loadPrefs();');
for (const [name, block] of [['S0F1b',wsSave],['S0F1d',insightSave],['S0F5a',tagSave]]) {
  check(block.includes('store.set('), `${name} write must use Library Store`);
  check(!block.includes('localStorage.setItem') && !block.includes('localStorage.removeItem'), `${name} direct localStorage write remains`);
}
check(src.workspace.includes('function readLegacyLayout()') && src.workspace.includes('W.localStorage.getItem(LAYOUT_KEY)'), 'S0F1b bounded legacy read compatibility missing');
check(src.insights.includes("JSON.parse(W.localStorage.getItem(PREFS_KEY) || '{}')"), 'S0F1d bounded legacy prefs read missing');
check(src.tags.includes("JSON.parse(W.localStorage.getItem(PREFS_KEY) || '{}')"), 'S0F5a bounded legacy prefs read missing');

const titleWrite = between(src.title, '  async function writeSharedRecord(key, value){', '\n\n  function broadcast(reason, payload){');
const titleBroadcast = between(src.title, '  function broadcast(reason, payload){', '\n\n  async function persistTitleState');
const titleMeta = between(src.title, '  async function persistInterfaceMeta(chatId, patch, reason){', '\n\n  async function defaultApplyMetaChoice');
const titleApply = between(src.title, '  async function defaultApplyMetaChoice(target, row){', '\n\n  function refreshMetaPalette');
check(titleWrite.includes('getLibraryStore()') && titleWrite.includes('await store.set(k, record)'), 'S9D1a shared record must use one Library Store writer');
check(!titleWrite.includes('localStorage.setItem') && !titleWrite.includes('chromeStorageSet') && !titleWrite.includes('chrome.storage'), 'S9D1a duplicate shared-record writer remains');
check(titleBroadcast.includes('Library?.Sync') && titleBroadcast.includes('platform?.broadcast?.emitRaw'), 'S9D1a broadcast must route through Sync/platform boundary');
check(!titleBroadcast.includes('chrome.storage') && !titleBroadcast.includes('chromeStorageSet'), 'S9D1a direct broadcast write remains');
check(titleMeta.includes('await readSharedRecord(key)') && !titleMeta.includes('localStorage.setItem'), 'S9D1a interface metadata must prefer Store with read-only legacy fallback');
check(titleApply.includes('await store.del(key)') && titleApply.includes('await store.set(key, level)') && titleApply.includes('await store.set(key, String(next))'), 'S9D1a heat/tint persistence must use Store');
check(!titleApply.includes('localStorage.setItem') && !titleApply.includes('localStorage.removeItem'), 'S9D1a heat/tint direct persistence remains');
check(!src.title.includes('function chromeStorageSet('), 'S9D1a direct Chrome storage helper remains');

const d1Services = between(src.services, "  const nativeLinkOpener = Object.freeze({", '\n\n  // ── Current-chat provider');
const d1Insights = between(src.insights, '  function openOriginalUrl(url, setStatus) {', '\n\n  function ');
check(d1Services.includes('platform?.runtime') && d1Services.includes('runtime.openUrl('), 'S0F1k must use platform.runtime.openUrl');
check(!d1Services.includes('chrome.tabs.create') && !d1Services.includes('W.open(') && !d1Services.includes('platform.openUrl'), 'S0F1k direct/top-level open fallback remains');
check(d1Insights.includes('platform?.runtime') && d1Insights.includes('runtime.openUrl(url)'), 'S0F1d must use platform.runtime.openUrl');
check(!d1Insights.includes('W.open(') && !d1Insights.includes('chrome.tabs.create') && !d1Insights.includes('platform.openUrl'), 'S0F1d direct/top-level open fallback remains');

check(src.host.includes('runtime: {') && src.host.includes('openUrl: unavailableAsync(\'runtime.openUrl\')'), 'Host fallback runtime provider missing');
check(src.host.includes('platform.runtime = current.runtime'), 'Host runtime binding missing');
check(src.mv3.includes('runtime:') && src.mv3.includes('openUrl: runtimeOpenUrl'), 'MV3 Host runtime.openUrl provider missing');

console.log(`STAB03_T02_LIBRARY_FOCUSED_VALIDATOR=PASS checks=${checks}`);
console.log('LIBRARY_C1_FROZEN_DIRECT_RUNTIME_SENDMESSAGE_BYPASSES=0');
console.log('LIBRARY_C1_MESSAGE_ENVELOPES_PRESERVED=PASS');
console.log('LIBRARY_C2_FROZEN_DIRECT_PERSISTENCE_WRITES=0');
console.log('LIBRARY_C2_FROZEN_DIRECT_CROSS_SURFACE_HEARTBEAT_WRITES=0');
console.log('LIBRARY_C2_SINGLE_WRITE_AUTHORITY=PASS');
console.log('D1_LIBRARY_CALLERS_USE_PLATFORM_RUNTIME_OPENURL=PASS');
console.log('D1_LIBRARY_CALLER_DIRECT_CHROME_TABS_FALLBACKS=0');
console.log('D1_LIBRARY_CALLER_DIRECT_WINDOW_OPEN_FALLBACKS=0');
console.log('HOST_D1_PROVIDER_PRESERVED=PASS');
