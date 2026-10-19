// 本地检查公式清理：node test-math.mjs
import fs from 'fs';
import katex from 'katex';

const src = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/m, '').replace(/export default[\s\S]*/, '');
const { fixEscapes, cleanMath, skeleton, toLatex, GEN_PROMPT } = new Function('katex',
  src + '; return { fixEscapes, cleanMath, skeleton, toLatex, GEN_PROMPT };')(katex);

let bad = 0;
const eq = (name, got, want) => { if (got !== want) { bad++; console.log('✗', name, '\n   得到', JSON.stringify(got), '\n   应为', JSON.stringify(want)); } else console.log('✓', name); };

// 模型把 \theta 写成单反斜杠
eq('单反斜杠', JSON.parse(fixEscapes(String.raw`{"b": "$\theta + \frac{1}{2} \nu \beta$"}`)).b, String.raw`$\theta + \frac{1}{2} \nu \beta$`);
eq('双反斜杠不动', JSON.parse(fixEscapes(String.raw`{"b": "$\\sin x$ \"引号\" 中"}`)).b, String.raw`$\sin x$ "引号" 中`);
eq('没加 $ 的公式', cleanMath('锐角 θ 的正弦 sinθ 等于什么？'), String.raw`锐角 $\theta$ 的正弦 $\sin \theta$ 等于什么？`);
eq('上标', cleanMath('x² + y² = r²，是圆'), String.raw`$x^2 + y^2 = r^2$，是圆`);
eq('\\( \\) 和 $$', cleanMath(String.raw`\(a+b\) 和 $$c^2$$`), '$a+b$ 和 $c^2$');
eq('普通英文不动', cleanMath('ephemeral, H2O, apple'), 'ephemeral, H2O, apple');
eq('坏公式去掉 $', cleanMath(String.raw`$\frac{1}{$ 坏了`), String.raw`\frac{1}{ 坏了`.replace('\\frac{1}{', String.raw`\frac{1}{`));
eq('已是 LaTeX', cleanMath(String.raw`$\sin^2\theta + \cos^2\theta = 1$`), String.raw`$\sin^2\theta + \cos^2\theta = 1$`);
eq('骨架', JSON.stringify(skeleton(['a/c', String.raw`\sin`, '='], String.raw`$\sin\theta = a/c$`)), JSON.stringify([String.raw`\sin`, '=']));
eq('提示词里的反斜杠', /\$\\sin\\theta = a\/c\$/.test(GEN_PROMPT), true);
console.log(bad ? `${bad} 项不对` : '全部通过');
