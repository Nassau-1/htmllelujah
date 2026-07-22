import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildSaveDialogDefaultPath,
  neutralizeWindowsReservedFileName,
} from '../src/main/save-dialog-default-path.js';

const fallbackDirectory = 'C:\\Users\\Enzo\\Documents';

describe('save-dialog default paths', () => {
  it('always returns a fully qualified path beside an authoritative Windows save target', () => {
    expect(
      buildSaveDialogDefaultPath({ fallbackDirectory, defaultFileName: 'New.hdeck' }, path.win32),
    ).toBe('C:\\Users\\Enzo\\Documents\\New.hdeck');
    expect(
      buildSaveDialogDefaultPath(
        {
          fallbackDirectory,
          defaultFileName: 'New.hdeck',
          currentSaveTarget: 'D:\\Decks\\Old.hdeck',
        },
        path.win32,
      ),
    ).toBe('D:\\Decks\\New.hdeck');
    expect(
      buildSaveDialogDefaultPath(
        {
          fallbackDirectory,
          defaultFileName: 'New.hdeck',
          currentSaveTarget: '\\\\server\\share\\Decks\\Old.hdeck',
        },
        path.win32,
      ),
    ).toBe('\\\\server\\share\\Decks\\New.hdeck');
  });

  it.each([
    'Old.hdeck',
    'C:Decks\\Old.hdeck',
    '\\Decks\\Old.hdeck',
    '\\\\?\\C:\\Decks\\Old.hdeck',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\Old.hdeck',
    '\\\\.\\pipe\\old.hdeck',
  ])('falls back instead of resolving an unsafe current target: %s', (currentSaveTarget) => {
    expect(
      buildSaveDialogDefaultPath(
        { fallbackDirectory, defaultFileName: 'New.hdeck', currentSaveTarget },
        path.win32,
      ),
    ).toBe('C:\\Users\\Enzo\\Documents\\New.hdeck');
  });

  it('preserves a fully qualified redirected Documents UNC path and Unicode file name', () => {
    expect(
      buildSaveDialogDefaultPath(
        {
          fallbackDirectory: '\\\\server\\share\\Documents',
          defaultFileName: 'Présentation été 你好.hdeck',
        },
        path.win32,
      ),
    ).toBe('\\\\server\\share\\Documents\\Présentation été 你好.hdeck');
  });

  it.each([
    ['CON', '_CON'],
    ['con.hdeck', '_con.hdeck'],
    [' NUL.hdeck', '_ NUL.hdeck'],
    ['   AUX .pdf', '_   AUX .pdf'],
    ['PrN .pdf', '_PrN .pdf'],
    ['AUX.', '_AUX.'],
    ['nul   ', '_nul   '],
    ['COM1.html', '_COM1.html'],
    ['com9 .PDF', '_com9 .PDF'],
    ['COM¹.html', '_COM¹.html'],
    ['com² .PDF', '_com² .PDF'],
    ['CoM³.hdeck', '_CoM³.hdeck'],
    ['LPT1..html', '_LPT1..html'],
    ['lpt9 ... ', '_lpt9 ... '],
    ['LPT¹.html', '_LPT¹.html'],
    ['lpt² .PDF', '_lpt² .PDF'],
    ['LPT³.hdeck', '_LPT³.hdeck'],
    ['CLOCK$.hdeck', '_CLOCK$.hdeck'],
    ['conin$.hdeck', '_conin$.hdeck'],
    ['ConOut$ .pdf', '_ConOut$ .pdf'],
  ])('neutralizes the reserved Windows file name %j', (fileName, expected) => {
    expect(neutralizeWindowsReservedFileName(fileName, path.win32)).toBe(expected);
  });

  it.each([
    'CONSOLE.hdeck',
    'PRINTER.pdf',
    'COM0.html',
    'COM10.html',
    'COM⁴.html',
    'LPT0.pdf',
    'LPT10.pdf',
    'LPT⁴.pdf',
    '_CON.hdeck',
    'AUXILIARY',
    '.NUL.hdeck',
  ])('preserves the ordinary Windows file name %j', (fileName) => {
    expect(neutralizeWindowsReservedFileName(fileName, path.win32)).toBe(fileName);
  });

  it('neutralizes a reserved default name before joining a Windows dialog path', () => {
    expect(
      buildSaveDialogDefaultPath({ fallbackDirectory, defaultFileName: 'CoM1 .hdeck' }, path.win32),
    ).toBe('C:\\Users\\Enzo\\Documents\\_CoM1 .hdeck');
  });

  it('does not apply Windows device-name semantics to a POSIX dialog path', () => {
    expect(
      buildSaveDialogDefaultPath(
        { fallbackDirectory: '/home/enzo/Documents', defaultFileName: 'CON.hdeck' },
        path.posix,
      ),
    ).toBe('/home/enzo/Documents/CON.hdeck');
  });

  it.each(['', '.', '..', '..\\New.hdeck', 'folder\\New.hdeck', 'bad\u0000name.hdeck'])(
    'rejects a non-file default name: %s',
    (defaultFileName) => {
      expect(() =>
        buildSaveDialogDefaultPath({ fallbackDirectory, defaultFileName }, path.win32),
      ).toThrow('plain file name');
    },
  );

  it('rejects a fallback directory that is not fully qualified', () => {
    expect(() =>
      buildSaveDialogDefaultPath(
        { fallbackDirectory: 'Documents', defaultFileName: 'New.hdeck' },
        path.win32,
      ),
    ).toThrow('fully qualified');
  });
});
