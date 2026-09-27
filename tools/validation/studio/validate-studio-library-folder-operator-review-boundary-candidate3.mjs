#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const EXPECTED_BASE = String(process.env.C3_EXPECTED_BASE || '').trim();
const PATHS = Object.freeze([
  'src-surfaces-base/studio/S0F1f. 🎬 Library Maintenance - Studio.js',
  'src-surfaces-base/studio/studio.js',
  'src-surfaces-base/studio/S0Z1f. 🎬 Library Sidebar Tab - Studio.js',
  'src-surfaces-base/studio/S0Z1g. 🎬 Library Sidebar Sections - Studio.js',
  'tools/validation/studio/validate-studio-library-folder-operator-review-boundary-candidate3.mjs',
]);
const MAINT = PATHS[0];
const STUDIO = PATHS[1];
const TAB = PATHS[2];
const SECTIONS = PATHS[3];
const STUDIO_HTML = 'src-surfaces-base/studio/studio.html';
const PACK = 'tools/product/studio/pack-studio.mjs';
const P02_PREFIXES = [
  'apps/studio/mobile/',
  'packages/browser-adapters/chrome/sync-p02-',
  'src-surfaces-base/studio/sync/sync-relationship-publication-desktop-v2.tauri.mjs',
  'tools/validation/sync/',
];

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function git(args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); }
function baseRead(rel) { return git(['show', EXPECTED_BASE + ':' + rel]); }
function changedPaths() { return git(['diff', '--name-only', EXPECTED_BASE + '...HEAD']).split('\n').filter(Boolean); }
function extractFunction(src,name){
  const p=src.indexOf('function '+name);
  const a=src.indexOf('async function '+name);
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
    if(c==="'"||c==='"'||c.charCodeAt(0)===96){str=c;continue;}
    if(c==='{') depth++;
    if(c==='}'){ depth--; if(depth===0) return src.slice(start,i+1); }
  }
  throw new Error('unterminated '+name);
}
function sameFn(cur,base,name){ assert.equal(extractFunction(cur,name),extractFunction(base,name),name+' must remain byte-equivalent'); }

if (!/^[0-9a-f]{40}$/.test(EXPECTED_BASE)) {
  console.error('REFUSE C3_EXPECTED_BASE_MISSING_OR_INVALID');
  process.exit(2);
}
const parent = git(['rev-parse','HEAD^']);
if (parent !== EXPECTED_BASE) {
  console.error('REFUSE C3_EXPECTED_BASE_IS_NOT_CANDIDATE_PARENT expected='+EXPECTED_BASE+' actual='+parent);
  process.exit(3);
}

const maintenance=read(MAINT);
const studio=read(STUDIO);
const tab=read(TAB);
const sections=read(SECTIONS);
const baseMaintenance=baseRead(MAINT);
const baseStudio=baseRead(STUDIO);
const changed=changedPaths();
const allowed=new Set(PATHS);
const results=[];
function check(id,fn){
  try { fn(); results.push([id,true]); console.log('PASS',id); }
  catch(e){ results.push([id,false,e.message]); console.error('FAIL',id,e.message); }
}

check('01_EXACT_PARENT',()=>assert.equal(parent,EXPECTED_BASE));
check('02_EXACT_FIVE_PATH_WRITE_SET',()=>{ assert.equal(changed.length,5); assert.deepEqual(new Set(changed),allowed); });
check('03_LIBRARY_OWNER_SURFACE',()=>{
  assert.match(maintenance,/FOLDER_OPERATOR_MODE_CONTRACT = 'h2o\.library\.folder-operator-mode\.v1'/);
  assert.match(maintenance,/FOLDER_OPERATOR_MODE_OWNER = 'L-COCKPIT-LIBRARY'/);
  assert.match(maintenance,/const folderOperatorMode = Object\.freeze/);
  assert.match(maintenance,/setEnabled: setFolderOperatorModeEnabled/);
  assert.match(maintenance,/hydrate: hydrateFolderOperatorMode/);
  assert.match(maintenance,/subscribe\(listener\)/);
  assert.match(maintenance,/folderOperatorMode,\n\s+inspectStore/);
});
check('04_DURABLE_STATE_AND_MIGRATION_OWNED_BY_LIBRARY',()=>{
  assert.match(maintenance,/store\.get\(FOLDER_OPERATOR_MODE_STORAGE_KEY\)/);
  assert.match(maintenance,/store\.set\(FOLDER_OPERATOR_MODE_STORAGE_KEY/);
  assert.match(maintenance,/legacy-localStorage/);
  assert.ok(!studio.includes('folderOperatorModeMemoryValue'));
  assert.ok(!studio.includes('folderOperatorModeHydrationSequence'));
  assert.ok(!studio.includes('folderLocalReviewOperatorMode ='));
});
check('05_SHELL_DELEGATED_COMPATIBILITY_FACADE',()=>{
  assert.match(studio,/H2O\?\.Library\?\.Maintenance\?\.folderOperatorMode/);
  assert.match(studio,/W\.H2O\.Studio\.folderOperatorMode = Object\.freeze/);
  assert.match(extractFunction(studio,'setFolderOperatorModeEnabled'),/api\.setEnabled\(next\)/);
  assert.match(extractFunction(studio,'installFolderOperatorModeApi'),/owner\.subscribe/);
});
check('06_CONSUMERS_HAVE_NO_ALTERNATE_OPERATOR_AUTHORITY',()=>{
  for(const src of [tab,sections]){
    assert.ok(!src.includes('H2O?.Studio?.folderOperatorMode'));
    assert.ok(!src.includes('folderLocalReviewOperatorMode'));
    assert.ok(!src.includes('localStorage?.getItem?.(FOLDER_LOCAL_REVIEW_OPERATOR_MODE_KEY)'));
    assert.match(src,/Library\?\.Maintenance\?\.folderOperatorMode/);
  }
});
check('07_OPERATOR_MODE_NOT_DESTRUCTIVE_AUTHORITY',()=>{
  const fn=extractFunction(sections,'folderDestructiveActionsEnabled');
  assert.match(fn,/folderOperatorModeEnabled\(\)/);
  assert.match(fn,/folderCommandAuthority\(\)/);
});
check('08_C5_D_REVIEW_APIS_PRESERVED',()=>{ sameFn(maintenance,baseMaintenance,'buildFolderReviewPlan'); sameFn(maintenance,baseMaintenance,'getFolderReviewPlan'); });
check('09_C5_A1_SEMANTICS_PRESERVED',()=>{ for(const name of ['migrateDownloadJson','migrateExtensionLabel','migrateGetArchiveBoot','renderMigrateExport','renderMigrateImport']) sameFn(studio,baseStudio,name); });
check('10_C5_F_DESTRUCTIVE_EXECUTION_NOT_CHANGED',()=>{ for(const name of ['deleteSelectedSafeChromeMirrorFolders','deleteSelectedEmptyDuplicateConflictFolders','deleteSelectedEmptyDesktopFolders','removeSelectedOrphanDesktopBinding']) sameFn(studio,baseStudio,name); });
check('11_SHELL_FOLDERLIST_LIFECYCLE_PRESERVED',()=>sameFn(studio,baseStudio,'renderFolderSidebar'));
check('12_STUDIO_HTML_UNCHANGED',()=>assert.ok(!changed.includes(STUDIO_HTML)));
check('13_PACK_STUDIO_UNCHANGED',()=>assert.ok(!changed.includes(PACK)));
check('14_NO_SHARED_ADMISSION_OR_NEW_RUNTIME_MODULE',()=>assert.ok(changed.every((p)=>allowed.has(p))));
check('15_P02_NON_OVERLAP',()=>assert.ok(changed.every((p)=>!P02_PREFIXES.some((prefix)=>p===prefix||p.startsWith(prefix)))));
check('16_CLASSIC_SCRIPT_SYNTAX',()=>{ new Function(maintenance); new Function(studio); new Function(tab); new Function(sections); });

const failed=results.filter((row)=>!row[1]);
console.log('CANDIDATE3_VALIDATOR='+(failed.length ? 'FAIL':'PASS')+' '+(results.length-failed.length)+'/'+results.length);
if(failed.length) process.exit(1);
