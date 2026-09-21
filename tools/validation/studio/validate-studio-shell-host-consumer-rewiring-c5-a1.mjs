#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const EXPECTED_BASE = String(process.env.C5_A1_EXPECTED_BASE || '').trim();
const STUDIO_REL = 'src-surfaces-base/studio/studio.js';
const VALIDATOR_REL = 'tools/validation/studio/validate-studio-shell-host-consumer-rewiring-c5-a1.mjs';
const PLATFORM_PREFIX = 'src-surfaces-base/studio/platform/';
const C5D_REL = 'src-surfaces-base/studio/S0F1f. 🎬 Library Maintenance - Studio.js';
const STUDIO_HTML = 'src-surfaces-base/studio/studio.html';
const PACK = 'tools/product/studio/pack-studio.mjs';

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function git(args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); }

if (!EXPECTED_BASE) {
  console.error('REFUSE EXPECTED_BASE_MISSING');
  process.exit(2);
}
if (!/^[0-9a-f]{40}$/.test(EXPECTED_BASE)) {
  console.error('REFUSE EXPECTED_BASE_INVALID');
  process.exit(2);
}
const CANDIDATE_PARENT = git(['rev-parse', 'HEAD^']);
if (CANDIDATE_PARENT !== EXPECTED_BASE) {
  console.error(`REFUSE EXPECTED_BASE_IS_NOT_CANDIDATE_PARENT expected=${EXPECTED_BASE} actual=${CANDIDATE_PARENT}`);
  process.exit(3);
}
const BASE = EXPECTED_BASE;

function baseRead(rel) { return git(['show', `${BASE}:${rel}`]); }
function changedPaths() {
  return git(['diff', '--name-only', `${BASE}...HEAD`]).split('\n').filter(Boolean);
}
function count(s,t){ return s.split(t).length - 1; }
function extractFunction(src,name){
  const p=src.indexOf(`function ${name}`);
  const a=src.indexOf(`async function ${name}`);
  const start=a>=0&&(p<0||a<p)?a:p;
  if(start<0) return '';
  const brace=src.indexOf('{',start);
  let depth=0,str=null,esc=false,line=false,block=false;
  for(let i=brace;i<src.length;i++){
    const c=src[i],n=src[i+1];
    if(line){ if(c==='\n') line=false; continue; }
    if(block){ if(c==='*'&&n==='/'){ block=false; i++; } continue; }
    if(str){ if(esc){esc=false;continue;} if(c==='\\'){esc=true;continue;} if(c===str)str=null; continue; }
    if(c==='/'&&n==='/'){line=true;i++;continue;}
    if(c==='/'&&n==='*'){block=true;i++;continue;}
    if(c==="'"||c==='"'||c==='`'){str=c;continue;}
    if(c==='{') depth++;
    if(c==='}'){ depth--; if(depth===0) return src.slice(start,i+1); }
  }
  throw new Error('unterminated '+name);
}
function sameFn(cur,base,name){
  assert.equal(extractFunction(cur,name), extractFunction(base,name), name+' must remain byte-equivalent');
}
function exactWriteSet(paths){
  const allowed=new Set([STUDIO_REL,VALIDATOR_REL]);
  return paths.length<=2 && paths.every(p=>allowed.has(p)) && paths.includes(STUDIO_REL) && paths.includes(VALIDATOR_REL);
}

const studio=read(STUDIO_REL);
const baseStudio=baseRead(STUDIO_REL);
const changed=changedPaths();
const results=[];
function check(id,fn){
  try { fn(); results.push([id,true]); console.log('PASS',id); }
  catch(e){ results.push([id,false,e.message]); console.error('FAIL',id,e.message); }
}

check('01_DIRECT_CHROME_RUNTIME_IDENTITY_ABSENT',()=>{ const b=extractFunction(studio,'migrateExtensionLabel'); assert.ok(!/chrome\?*\.runtime|chrome\.runtime/.test(b)); });
check('02_PLATFORM_RUNTIME_IDENTITY_CONSUMED',()=>assert.match(extractFunction(studio,'migrateExtensionLabel'),/getLoadedRuntimeIdentity/));
check('03_NAME_DERIVED_BUILD_CHANNEL_HEURISTIC_ABSENT',()=>{ assert.ok(!studio.includes('/Cockpit Pro/i.test(nm)')); assert.ok(!studio.includes('/Dev Controls/i.test(nm)')); assert.ok(!studio.includes('/Lean/i.test(nm)')); });
check('04_BUILD_PROVENANCE_NOT_INFERRED_FROM_DISPLAY_NAME',()=>assert.match(extractFunction(studio,'refreshSettingsDiagnostics'),/versionName/));

check('05_DIRECT_OBJECT_URL_DOWNLOAD_ABSENT',()=>{ const b=extractFunction(studio,'migrateDownloadJson'); assert.ok(!b.includes('URL.createObjectURL')); assert.ok(!b.includes('createElement("a")')); });
check('06_PLATFORM_EXPORT_BLOB_CONSUMED',()=>assert.match(extractFunction(studio,'migrateDownloadJson'),/files\.exportBlob/));
check('07_DIRECT_FILE_INPUT_ABSENT',()=>assert.ok(!extractFunction(studio,'renderMigrateImport').includes('createElement("input")')));
check('08_DIRECT_FILE_TEXT_ABSENT',()=>assert.ok(!extractFunction(studio,'renderMigrateImport').includes('.text()')));
check('09_PLATFORM_IMPORT_FILE_CONSUMED',()=>assert.match(extractFunction(studio,'renderMigrateImport'),/files\.importFile/));

check('10_IDENTITY_UNAVAILABLE_FAILS_CLOSED',()=>{ const b=extractFunction(studio,'migrateExtensionLabel'); assert.match(b,/runtime info unavailable/); assert.ok(!b.includes('unknown id')); });
check('11_IMPORT_CANCEL_NON_ERROR',()=>{ const b=extractFunction(studio,'renderMigrateImport'); assert.match(b,/if \(!file\)/); assert.match(b,/File selection cancelled/); });
check('12_IMPORT_READ_FAILURE_NOT_CANCEL',()=>{ const b=extractFunction(studio,'renderMigrateImport'); assert.match(b,/Bundle rejected/); assert.match(b,/files\.importFile/); });
check('13_EXPORT_CANCEL_NON_ERROR',()=>{ const b=extractFunction(studio,'renderMigrateExport'); assert.match(b,/reason === "cancelled"/); assert.match(b,/Download cancelled/); });
check('14_EXPORT_FAILURE_NOT_SUCCESS',()=>{ const b=extractFunction(studio,'migrateDownloadJson'); assert.match(b,/returned unsuccessful result/); });
check('15_BACKUP_CANCEL_FAILURE_DOES_NOT_ENABLE_IMPORT',()=>{ const b=extractFunction(studio,'renderMigrateImport'); const cancel=b.indexOf('Backup cancelled'); const enable=b.indexOf('btnImport.disabled = false',cancel); assert.ok(cancel>=0); assert.ok(b.slice(Math.max(0,cancel-220),cancel+220).includes('backupSaved = false')); assert.ok(enable>cancel); });

check('16_MIGRATE_GET_ARCHIVE_BOOT_UNCHANGED',()=>sameFn(studio,baseStudio,'migrateGetArchiveBoot'));
check('17_EXPORT_FULL_BUNDLE_FLOW_PRESERVED',()=>{ assert.match(extractFunction(studio,'renderMigrateExport'),/exportFullBundle/); assert.match(extractFunction(studio,'renderMigrateImport'),/exportFullBundle/); });
check('18_ACCEPTED_SCHEMA_SET_EXACT',()=>{ const b=extractFunction(studio,'renderMigrateImport'); assert.equal(count(b,'h2o.studio.fullBundle.v2'),2); assert.equal(count(b,'h2o.chatArchive.bundle.v1'),2); });
check('19_INVALID_JSON_FAILS_BEFORE_DRY_RUN',()=>{ const b=extractFunction(studio,'renderMigrateImport'); assert.ok(b.indexOf('JSON.parse(text)') < b.indexOf('btnDry.disabled = false')); });
check('20_UNKNOWN_SCHEMA_FAILS_BEFORE_DRY_RUN',()=>{ const b=extractFunction(studio,'renderMigrateImport'); assert.ok(b.indexOf('Unrecognized bundle schema') < b.indexOf('btnDry.disabled = false')); });
check('21_DRY_RUN_REMAINS_REQUIRED',()=>assert.match(extractFunction(studio,'renderMigrateImport'),/dryRunImportFullBundle/));
check('22_BACKUP_REMAINS_REQUIRED',()=>{ const b=extractFunction(studio,'renderMigrateImport'); assert.match(b,/if \(!parsedBundle \|\| !backupSaved\) return/); });
check('23_MERGE_CONFIRMATION_PRESERVED',()=>{ const b=extractFunction(studio,'renderMigrateImport'); assert.match(b,/Confirm import \(merge mode\)/); assert.match(b,/mode: "merge"/); });
check('24_IMPORTED_EVENT_PRESERVED',()=>assert.match(extractFunction(studio,'renderMigrateImport'),/evt:h2o:data:backup:imported/));

check('25_PLATFORM_OWNER_FILES_UNCHANGED',()=>assert.ok(changed.every(p=>!p.startsWith(PLATFORM_PREFIX))));
check('26_C5_D_OWNER_API_UNCHANGED',()=>assert.ok(!changed.includes(C5D_REL)));
check('27_CANDIDATE3_C5F_UNCHANGED',()=>{
  for(const n of ['folderOperatorModeEnabled','setFolderOperatorModeEnabled','deleteSelectedSafeChromeMirrorFolders','deleteSelectedEmptyDuplicateConflictFolders','deleteSelectedEmptyDesktopFolders','removeSelectedOrphanDesktopBinding']) sameFn(studio,baseStudio,n);
});
check('28_STUDIO_HTML_UNCHANGED',()=>assert.ok(!changed.includes(STUDIO_HTML)));
check('29_PACK_STUDIO_UNCHANGED',()=>assert.ok(!changed.includes(PACK)));
check('30_P02_PATHS_UNCHANGED',()=>{ assert.ok(!changed.includes('src-surfaces-base/studio/sync/sync-relationship-publication-desktop-v2.tauri.mjs')); assert.ok(!changed.includes(PACK)); });
check('31_EXACT_WRITE_SET_MAX_2',()=>assert.ok(exactWriteSet(changed)));
check('32_STUDIO_JS_SYNTAX',()=>{ new Function(studio); });

const negatives=[
  ['NC1_DIRECT_CHROME_RUNTIME', s=>s.replace('const runtime = W.H2O?.Studio?.platform?.runtime;','const runtime = chrome.runtime;'), s=>!/chrome\.runtime/.test(extractFunction(s,'migrateExtensionLabel'))],
  ['NC2_NAME_HEURISTIC', s=>s.replace('if (elBuild) elBuild.textContent = meta.versionName || "(unavailable)";','if (/Cockpit Pro/i.test(meta.name)) elBuild.textContent = "production";'), s=>!s.includes('/Cockpit Pro/i.test(meta.name)')],
  ['NC3_DIRECT_OBJECT_URL', s=>s.replace('const result = await files.exportBlob({ suggestedName, blob });','const url = URL.createObjectURL(blob);\n  const result = await files.exportBlob({ suggestedName, blob });'), s=>!extractFunction(s,'migrateDownloadJson').includes('URL.createObjectURL')],
  ['NC4_DIRECT_FILE_INPUT', s=>s.replace('const btnPick = document.createElement("button");','const fileInput = document.createElement("input");\n  const btnPick = document.createElement("button");'), s=>!extractFunction(s,'renderMigrateImport').includes('createElement("input")')],
  ['NC5_IMPORT_CANCEL_ENABLES_DRYRUN', s=>s.replace('log.textContent = "File selection cancelled.";\n        return;','log.textContent = "File selection cancelled.";\n        btnDry.disabled = false;\n        return;'), s=>!extractFunction(s,'renderMigrateImport').includes('File selection cancelled.";\n        btnDry.disabled = false')],
  ['NC6_BACKUP_CANCEL_MARKS_SAVED', s=>s.replace('backupSaved = false;\n        log.textContent += "\\nBackup cancelled', 'backupSaved = true;\n        log.textContent += "\\nBackup cancelled'), s=>!extractFunction(s,'renderMigrateImport').includes('backupSaved = true;\n        log.textContent += "\\nBackup cancelled')],
  ['NC7_ARCHIVE_SEMANTIC_MUTATION', s=>s.replace('exportFullBundle: (opts = {}) => callArchive("exportFullBundle", opts || {})','exportFullBundle: (opts = {}) => callArchive("exportBundle", opts || {})'), s=>extractFunction(s,'migrateGetArchiveBoot')===extractFunction(baseStudio,'migrateGetArchiveBoot')],
  ['NC8_THIRD_PATH', s=>s, ()=>exactWriteSet([...changed,'src-surfaces-base/studio/studio.html'])],
];
let ncPass=0;
for(const [id,mutate,predicate] of negatives){
  const mutated=mutate(studio);
  const rejected=!predicate(mutated);
  console.log(rejected?'PASS':'FAIL',id,rejected?'rejected':'not rejected');
  if(rejected) ncPass++;
}
console.log(`NEGATIVE_CONTROLS=${ncPass}/${negatives.length}`);

const failed=results.filter(x=>!x[1]);
console.log(`C5_A1_VALIDATOR=${failed.length===0 && ncPass===negatives.length ? 'PASS':'FAIL'}`);
if(failed.length || ncPass!==negatives.length) process.exit(1);
