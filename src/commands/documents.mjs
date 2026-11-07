/** Read bodies without loading document mutations or the legacy dispatcher. */
export async function load({positionals}) {
  return positionals[1]==='view'?import('./documents-view.mjs'):(await import('./legacy.mjs')).load();
}

export async function run(argv,{positionals,options}) {
  if(positionals[1]==='view')return (await load({positionals})).run(argv,{positionals,options});
  return (await import('./legacy.mjs')).run(argv);
}
