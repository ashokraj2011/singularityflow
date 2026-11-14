/** A real AST host adapter used against source bytes read by SGOS. No lifecycle success flags. */
import ts from 'typescript';import path from 'node:path';import {createHash} from 'node:crypto';
import {createSourceTestImpactUnit} from '../../src/sgos/source-test-impact.mjs';
export function fixtureImpactUnit(f,{unknown=false,analyze:override}={}){
  const analyze=async({files},{signal}={})=>{
    if(override)return override({files},{signal});
    const nodes=[],gaps=[],index=new Set(files.map(row=>JSON.stringify([row.repositoryId,row.path])));
    for(const file of files){signal?.throwIfAborted();const dependencies=[],ast=ts.createSourceFile(file.path,Buffer.from(file.bytes).toString('utf8'),ts.ScriptTarget.Latest,true),seen=new Set();
      if(ast.parseDiagnostics.length||!/\.[cm]?[jt]sx?$/u.test(file.path))gaps.push({repositoryId:file.repositoryId,path:file.path,reason:'unsupported-syntax-or-input'});
      const add=specifier=>{if(specifier.startsWith('node:')){if(!['node:test','node:assert/strict','node:assert'].includes(specifier))gaps.push({repositoryId:file.repositoryId,path:file.path,reason:'external-builtin-state'});return;}
        if(!specifier.startsWith('.')){gaps.push({repositoryId:file.repositoryId,path:file.path,reason:'external-framework-resolution'});return;}
        const target=path.posix.normalize(path.posix.join(path.posix.dirname(file.path),specifier)),id=JSON.stringify([file.repositoryId,target]);
        if(!index.has(id)){gaps.push({repositoryId:file.repositoryId,path:file.path,reason:'unresolved-import'});return;}if(!seen.has(id)){seen.add(id);dependencies.push({repositoryId:file.repositoryId,path:target});}};
      const visit=node=>{
        if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)add(node.moduleSpecifier.text);
        if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&['require','eval','Function'].includes(node.expression.text)))
          gaps.push({repositoryId:file.repositoryId,path:file.path,reason:'dynamic-dependency'});
        ts.forEachChild(node,visit);
      };visit(ast);nodes.push({repositoryId:file.repositoryId,path:file.path,sha256:file.sha256,dependencies});
    }
    if(unknown&&files.length)gaps.push({repositoryId:files[0].repositoryId,path:files[0].path,reason:'incomplete-semantic-resolution'});
    return {nodes,unknown:gaps};
  };
  return createSourceTestImpactUnit({sources:f.sources.map((unit,index)=>({unit,content:f.sourceReaders[index]})),analyzer:{
    descriptor:{id:'fixture-typescript-ast',version:'1.0.0',implementationSha256:'sha256:'+createHash('sha256').update(analyze.toString()).digest('hex')},analyze}});
}
