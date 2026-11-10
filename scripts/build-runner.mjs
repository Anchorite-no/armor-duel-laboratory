import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export async function buildRunners(directory){
  await mkdir(directory,{recursive:true});
  for(const name of ['runner','vision-worker'])await build({entryPoints:[`src/host/${name}.mjs`],outfile:path.join(directory,`${name}.mjs`),bundle:true,platform:'node',target:'node24',format:'esm'});
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await buildRunners('.local/runner');
