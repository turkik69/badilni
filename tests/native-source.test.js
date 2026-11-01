const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const exists = file => fs.existsSync(path.join(root, file));
const pkg = JSON.parse(read('package.json'));
const capacitor = JSON.parse(read('capacitor.config.json'));
const androidManifest = read('android/app/src/main/AndroidManifest.xml');
const androidGradle = read('android/app/build.gradle');
const androidVariables = read('android/variables.gradle');
const iosInfo = read('ios/App/App/Info.plist');
const iosDelegate = read('ios/App/App/AppDelegate.swift');
const push = read('push.js');

function pngDimensions(file) {
  const data = fs.readFileSync(path.join(root, file));
  assert.equal(data.toString('ascii', 1, 4), 'PNG');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colorType: data[25] };
}

assert.equal(capacitor.appId, 'com.byyassmin.badilni');
assert.ok(exists('android/gradlew'));
assert.ok(exists('ios/App/App.xcodeproj/project.pbxproj'));
assert.match(androidGradle, /applicationId "com\.byyassmin\.badilni"/);
assert.match(androidVariables, /targetSdkVersion = 36/);
assert.match(androidManifest, /android:allowBackup="false"/);
assert.match(androidManifest, /android:usesCleartextTraffic="false"/);
assert.match(androidManifest, /android\.permission\.POST_NOTIFICATIONS/);
assert.match(iosInfo, /<key>CFBundleDisplayName<\/key>[\s\S]*?<string>بادلني<\/string>/);
assert.match(iosInfo, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
assert.doesNotMatch(iosInfo, /UIInterfaceOrientationLandscape/);
assert.match(iosDelegate, /didRegisterForRemoteNotificationsWithDeviceToken/);
assert.match(iosDelegate, /didFailToRegisterForRemoteNotificationsWithError/);
assert.ok(pkg.dependencies['@capacitor-firebase/messaging']?.startsWith('^8.'));
assert.match(push, /Plugins\?\.FirebaseMessaging/);
assert.match(push, /getToken\(\)/);
const iosPluginLink = 'ios/App/CapApp-SPM/symlinks/CapacitorFirebaseMessaging';
assert.ok(fs.lstatSync(path.join(root, iosPluginLink)).isSymbolicLink());
assert.ok(!path.isAbsolute(fs.readlinkSync(path.join(root, iosPluginLink))), 'Swift package link must work in any checkout');
assert.ok(exists(path.join(iosPluginLink, 'Package.swift')));

const iosIcon = pngDimensions('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
assert.deepEqual({ width: iosIcon.width, height: iosIcon.height }, { width: 1024, height: 1024 });
assert.notEqual(iosIcon.colorType, 4, 'App Store icon must not use an alpha-only color type');
assert.notEqual(iosIcon.colorType, 6, 'App Store icon must be opaque');
const androidIcon = pngDimensions('android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png');
assert.deepEqual({ width: androidIcon.width, height: androidIcon.height }, { width: 192, height: 192 });

const missingServices = [
  ['android/app/google-services.json', 'Firebase Android configuration'],
  ['ios/App/App/GoogleService-Info.plist', 'Firebase iOS configuration']
].filter(([file]) => !exists(file));
if (missingServices.length) {
  const list = missingServices.map(([file, label]) => `${label}: ${file}`).join('\n- ');
  if (process.env.REQUIRE_NATIVE_SERVICES === '1') throw new Error(`Native release credentials are missing:\n- ${list}`);
  console.warn(`⚠ Native source is valid; add the private Firebase platform files before signed builds:\n- ${list}`);
}

console.log('✓ native Android/iOS source, identity, privacy flags, icons, and FCM bridge passed');
