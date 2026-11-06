import {copyFile} from 'node:fs/promises';
// Browser-only modules have no Node, credential or transport imports.
await copyFile(new URL('../dist/account-auth.js',import.meta.url),new URL('../extension/account-auth.js',import.meta.url));
