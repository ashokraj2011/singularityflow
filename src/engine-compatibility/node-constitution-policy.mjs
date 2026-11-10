/** Explicit Node syntax binding. No file discovery, formatter, CLI, clock or authority. */
import YAML from 'yaml';
import path from 'node:path';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {constitutionValuePolicies,CONSTITUTION_SYNTAX_PROFILE} from '../kernel/constitution.mjs';
export const NODE_CONSTITUTION_VALUES=/* @__PURE__ */ constitutionValuePolicies(NODE_TEXT_DIGESTS,
  Object.freeze({profile:CONSTITUTION_SYNTAX_PROFILE,parse:source=>YAML.parse(source)}),{pathSeparator:path.sep});
