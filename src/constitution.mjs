export {CONSTITUTION_MODES,DEFAULT_CONSTITUTION_PATH,constitutionPolicy} from './engine-compatibility/node-configuration-path.mjs';
/** Native file/syntax/formatting adapter. Standing-rule values have one pure owner. */
import {createHash} from 'node:crypto';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import YAML from 'yaml';
import {exists,posix} from './util.mjs';
import {NODE_TEXT_DIGESTS} from './records.mjs';
import {CONSTITUTION_RECORD_SCHEMA} from './foundation/record-schema.mjs';
import {constitutionValuePolicies,CONSTITUTION_SYNTAX_PROFILE} from './kernel/constitution.mjs';
import {renderDataPreservingFormatting} from './yaml-formatting.mjs';
export const CONSTITUTION_SCHEMA_VERSION=CONSTITUTION_RECORD_SCHEMA.currentVersion;
const values=/* @__PURE__ */ constitutionValuePolicies(NODE_TEXT_DIGESTS,Object.freeze({profile:CONSTITUTION_SYNTAX_PROFILE,parse:source=>YAML.parse(source)}),{pathSeparator:path.sep});
export const RENDERER_VERSION=values.RENDERER_VERSION;
export const ARTICLE_TYPES=values.ARTICLE_TYPES;
export const ARTICLE_LEVELS=values.ARTICLE_LEVELS;
export const normalizeArticle=values.normalizeArticle;
export const policyValue=values.policyValue;
export const renderEnforcedArticle=values.renderEnforcedArticle;
export const articleHash=values.articleHash;
export const articleSections=values.articleSections;
export const generatedProse=values.generatedProse;
export const constitutionIndex=values.constitutionIndex;
export const constitutionPin=values.constitutionPin;
export const citedArticleIds=values.citedArticleIds;
export const validateCitations=values.validateCitations;
export const requiredArticles=values.requiredArticles;
export const buildConstitutionException=values.buildConstitutionException;
export const expiredExceptions=values.expiredExceptions;
export function parseConstitution(markdown,options){const result=values.parseConstitution(markdown,options);
  return {...result,findings:result.findings.map(row=>row.kind==='missing-generated-block'?{...row,message:`${row.id} is enforced and has no generated block; run singularity-flow constitution generate`}:row)};
}
export function generateConstitution(markdown,resolution){const plan=values.generationPlan(markdown,resolution),frontMatter=renderDataPreservingFormatting(`${plan.frontMatter}\n`,plan.declaration).trimEnd();
  return {markdown:`---\n${frontMatter}\n---\n${plan.body}`,regenerated:plan.regenerated,articles:plan.articles};
}

/** Load and parse the constitution a Story is held to, or null when the profile declares none. */
export async function loadConstitution(root, relative, { resolution = null, allowExample = false } = {}) {
  const absolute = path.join(root, relative);
  if (!(await exists(absolute))) return null;
  const markdown = await readFile(absolute, 'utf8');
  const { articles, findings } = parseConstitution(markdown, { resolution, allowExample });
  return {
    path: posix(relative),
    markdown,
    fileSha256: createHash('sha256').update(markdown, 'utf8').digest('hex'),
    articles,
    findings
  };
}
