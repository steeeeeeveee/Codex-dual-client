import {Marked} from '../static/vendor/marked.mjs';
const parser=new Marked({gfm:true});
export function imageReferences(text){
  const refs=[];
  parser.walkTokens(parser.lexer(text),token=>{
    if(token.type==='image'||token.type==='link'&&/\.(?:png|jpe?g|webp|gif|hei[cf])(?:[?#].*)?$/i.test(token.href))refs.push(token.href);
  });
  return [...new Set(refs)];
}
if(process.argv[1]?.endsWith('media-references.mjs')){
  let input='';for await(const chunk of process.stdin)input+=chunk;
  process.stdout.write(JSON.stringify(JSON.parse(input).map(imageReferences)));
}
