import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const link = resolve(root, 'ios/App/CapApp-SPM/symlinks/CapacitorFirebaseMessaging');
const target = resolve(root, 'node_modules/@capacitor-firebase/messaging');
if (!existsSync(target) || !existsSync(link) || !lstatSync(link).isSymbolicLink()) {
  throw new Error('Capacitor Firebase Messaging Swift package link is missing');
}
if (isAbsolute(readlinkSync(link))) {
  unlinkSync(link);
  symlinkSync(relative(dirname(link), target), link);
}
console.log('Swift package link is checkout independent');
