#!/usr/bin/env node
/**
 * Debug APK for the emulator (x86_64) and `adb install -r` on the connected
 * device. Run through `npm run android:debug`, which syncs web + node first.
 *
 *   TERMILAB_ABI=arm64-v8a npm run android:debug    # a real phone instead
 *
 * JAVA_HOME / ANDROID_HOME default to ~/Android/jdk and ~/Android/Sdk when
 * unset (the toolchain layout in docs/android-plan.md).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'mobile', 'android');
const abi = process.env.TERMILAB_ABI || 'x86_64';

const env = { ...process.env };
if (!env.JAVA_HOME && fs.existsSync(path.join(os.homedir(), 'Android', 'jdk'))) env.JAVA_HOME = path.join(os.homedir(), 'Android', 'jdk');
if (!env.ANDROID_HOME && fs.existsSync(path.join(os.homedir(), 'Android', 'Sdk'))) env.ANDROID_HOME = path.join(os.homedir(), 'Android', 'Sdk');
if (env.JAVA_HOME) env.PATH = `${path.join(env.JAVA_HOME, 'bin')}${path.delimiter}${env.PATH}`;

const gradlew = path.join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
execFileSync(gradlew, ['assembleDebug', `-PtermilabAbis=${abi}`], { cwd: ANDROID, env, stdio: 'inherit' });

const apk = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', `app-${abi}-debug.apk`);
if (!fs.existsSync(apk)) throw new Error(`APK not found: ${apk}`);
console.log(`APK: ${path.relative(ROOT, apk)} (${(fs.statSync(apk).size / 1e6).toFixed(1)} MB)`);

const adb = env.ANDROID_HOME ? path.join(env.ANDROID_HOME, 'platform-tools', 'adb') : 'adb';
execFileSync(adb, ['install', '-r', apk], { env, stdio: 'inherit' });
