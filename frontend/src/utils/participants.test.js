import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePastedParticipants } from './participants.js';

test('reads comma, tab and semicolon separated lines in any column order', () => {
  assert.deepEqual(parsePastedParticipants('an@fpt.edu.vn, Nguyễn Văn An, SE170001\nSE170002\tTrần Bình\tbinh@fpt.edu.vn\n  \nchi@fpt.edu.vn; Lê Chi'), [
    { email: 'an@fpt.edu.vn', name: 'Nguyễn Văn An', mssv: 'SE170001' },
    { email: 'binh@fpt.edu.vn', name: 'Trần Bình', mssv: 'SE170002' },
    { email: 'chi@fpt.edu.vn', name: 'Lê Chi', mssv: '' },
  ]);
});

test('drops a pasted Excel header row and the STT column', () => {
  assert.deepEqual(parsePastedParticipants('STT\tHọ tên\tEmail\n1\tAn\tan@fpt.edu.vn'), [
    { email: 'an@fpt.edu.vn', name: 'An', mssv: '' },
  ]);
});

test('a line without an email is kept so the server can report it', () => {
  assert.deepEqual(parsePastedParticipants('an@fpt.edu.vn, An\nChỉ có tên'), [
    { email: 'an@fpt.edu.vn', name: 'An', mssv: '' },
    { email: '', name: 'Chỉ có tên', mssv: '' },
  ]);
});
