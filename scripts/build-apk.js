// One-command APK build:   npm run apk            -> debug APK (installable, unsigned-by-you)
//                          npm run apk -- --release -> signed release APK (needs android/key.properties)
//                          npm run apk -- --open  -> just open the project in Android Studio
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), android = path.join(root, 'android'), win = process.platform === 'win32';
const args = process.argv.slice(2), release = args.includes('--release');
const run = (cmd, a, cwd, opt) => { const r = spawnSync(cmd, a, Object.assign({ cwd: cwd || root, stdio: 'inherit', shell: win }, opt || {})); if (r.status !== 0) { console.error('\n✖ Failed:', cmd, a.join(' ')); process.exit(r.status || 1); } };
const have = (cmd, a) => { const r = spawnSync(cmd, a, { shell: win, encoding: 'utf8' }); return r.status === 0 ? (r.stdout + r.stderr) : null; };
const step = (n, t) => console.log('\n\x1b[36m[' + n + '] ' + t + '\x1b[0m');
if (args.includes('--open')) { run('npx', ['cap', 'open', 'android']); process.exit(0); }
step(1, 'Checking tools');
const node = parseInt(process.versions.node, 10); if (node < 18) { console.error('Node 18+ is required (found ' + process.versions.node + ').'); process.exit(1); }
const jv = have('java', ['-version']); if (!jv) { console.error('✖ Java (JDK 17) not found. Install it (e.g. Temurin 17) or install Android Studio, then reopen the terminal.'); process.exit(1); }
const jm = /version "(\d+)/.exec(jv); if (jm && (+jm[1] < 17 || +jm[1] > 21)) { console.error('✖ JDK 17–21 is required (found ' + jm[1] + '). Install JDK 17 and reopen the terminal.'); process.exit(1); }
let sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const lp = path.join(android, 'local.properties');
if (!sdk && fs.existsSync(lp)) { const m = /sdk\.dir=(.+)/.exec(fs.readFileSync(lp, 'utf8')); if (m) sdk = m[1].trim().replace(/\\\\/g, '\\'); }
if (!sdk) { const guess = win ? path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk') : path.join(process.env.HOME || '', process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk'); if (fs.existsSync(guess)) sdk = guess; }
if (!sdk || !fs.existsSync(sdk)) { console.error('✖ Android SDK not found. Install Android Studio (it installs the SDK), or set ANDROID_HOME to your SDK folder.'); process.exit(1); }
if (!fs.existsSync(lp)) fs.writeFileSync(lp, 'sdk.dir=' + sdk.replace(/\\/g, '\\\\') + '\n');
console.log('Node ' + process.versions.node + ' · ' + (jv.split('\n')[0] || '').trim() + ' · SDK ' + sdk);
step(2, 'Installing npm packages'); if (!fs.existsSync(path.join(root, 'node_modules', '@capacitor'))) run('npm', ['install']); else console.log('already installed');
step(3, 'Preparing web assets and syncing the Android project'); run('node', [path.join('scripts', 'prepare-www.js')]); run('npx', ['cap', 'sync', 'android']);
step(4, release ? 'Building signed RELEASE apk' : 'Building DEBUG apk');
if (release && !fs.existsSync(path.join(android, 'key.properties'))) { console.error('✖ android/key.properties not found. See README ("Signing a release").'); process.exit(1); }
const gw = win ? 'gradlew.bat' : './gradlew'; if (!win) { try { fs.chmodSync(path.join(android, 'gradlew'), 0o755); } catch (e) {} }
run(gw, [release ? 'assembleRelease' : 'assembleDebug'], android);
const outDir = path.join(android, 'app', 'build', 'outputs', 'apk', release ? 'release' : 'debug');
const apk = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter(f => f.endsWith('.apk')).sort()[0] : null;
if (!apk) { console.error('✖ Build finished but no APK was found in ' + outDir); process.exit(1); }
const dist = path.join(root, 'dist'); fs.mkdirSync(dist, { recursive: true });
const target = path.join(dist, 'Living-Ideas-' + (release ? 'release' : 'debug') + '.apk'); fs.copyFileSync(path.join(outDir, apk), target);
console.log('\n\x1b[32m✔ Done: ' + target + '\x1b[0m\nInstall:  adb install -r "' + target + '"   (or copy it to the phone and open it)');
