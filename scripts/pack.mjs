// 사용법: node scripts/pack.mjs [full]
// 기본은 스토어용(FULL=false): dist/cosmate-v<버전>/에 따로 빌드·복사하고 GitHub 전용 코드와 문구를 뺀 뒤
// .zip으로 묶음. js/는 건드리지 않음. full은 GitHub용(dist/cosmate-v<버전>-full.zip).
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const full = process.argv[2] === 'full';
const { version } = JSON.parse(readFileSync('manifest.json', 'utf8'));
const dir = `dist/cosmate-v${version}${full ? '-full' : ''}`; // 압축을 푼 모습 그대로라 크롬에서 바로 로드해 볼 수 있음
const zip = resolve(dir + '.zip');

rmSync(dir, { recursive: true, force: true });
rmSync(zip, { force: true }); // zip -r은 기존 파일에 덧붙이므로 먼저 지움
for (const p of ['manifest.json', 'pages', 'assets', 'LICENSE', 'vendor']) cpSync(p, `${dir}/${p}`, { recursive: true });

// 같은 플래그를 뒤에 다시 주면 build 스크립트의 값을 덮어씀. --minify-syntax가 있어야 꺼진 FULL 블록이 번들에서 빠짐.
execFileSync('npm', ['run', 'build', '--', `--outdir=${dir}/js`, ...(full ? [] : ['--define:FULL=false', '--minify-syntax'])], { stdio: 'inherit' });

// <!--full-->…<!--/full-->: GitHub용에서는 표시만 지우고 스토어용에서는 내용까지 지움.
const mark = full ? /<!--\/?full-->/g : /<!--full-->[\s\S]*?<!--\/full-->/g;
for (const f of ['popup', 'welcome']) {
  const p = `${dir}/pages/${f}.html`;
  writeFileSync(p, readFileSync(p, 'utf8').replace(mark, ''));
}

// 스토어용에 GitHub 전용 코드가 남았으면 중단함. grep은 없으면 1, 있으면 0, 오류면 2를 돌려줌.
if (!full) {
  const left = spawnSync('grep', ['-rnE', 'cmxAutoplay|goNext|autoNext|FULL|다음 ?영상|<!--/?full-->', `${dir}/js`, `${dir}/pages`], { encoding: 'utf8' });
  if (left.status !== 1) throw new Error('스토어용 검사 실패(GitHub 전용 코드가 남았거나 grep 오류):\n' + left.stdout + left.stderr);
}

execFileSync('zip', ['-X', '-r', zip, '.', '-x', '*.DS_Store'], { cwd: dir, stdio: 'ignore' });
console.log(zip);
