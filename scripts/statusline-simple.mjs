// Simplest possible statusLine script — just writes a file and prints to stdout
import { appendFileSync } from 'node:fs';
appendFileSync('/Users/hungnguyen/Documents/poc/loop/loop-engineering-plugin/.loop/scratch/simple-probe.txt', new Date().toISOString() + '\n');
process.stdout.write('SIMPLE_OK');
