// 用 KaTeX 检查一批公式能不能渲染：node check-texs.mjs 公式列表.json
import fs from 'fs';
import katex from 'katex';

const texs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let bad = 0;
for (const t of texs) {
  try { katex.renderToString(t, { throwOnError: true, strict: 'ignore' }); } catch (e) { bad++; console.log('✗', t, '—', e.message.slice(0, 80)); }
}
console.log(`${texs.length} 个公式，${bad} 个渲染不了`);
