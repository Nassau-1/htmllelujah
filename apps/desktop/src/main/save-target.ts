export interface SaveTargetState {
  readonly exists: boolean;
}

export interface ApprovedSaveTarget<State extends SaveTargetState> {
  readonly path: string;
  readonly state: State;
}

export interface ResolveSaveTargetOptions<State extends SaveTargetState> {
  readonly selectedPath: string;
  readonly extension: `.${string}`;
  readonly inspect: (targetPath: string) => Promise<State>;
  readonly confirmAddedExtensionOverwrite: (targetPath: string) => Promise<boolean>;
}

/**
 * Resolves the exact path that will be written after adding a required extension.
 *
 * Native save dialogs only confirm replacement of the path selected by the user. If
 * the application appends an extension, the resulting file is a different target and
 * therefore needs its own explicit overwrite confirmation.
 */
export const resolveSaveTarget = async <State extends SaveTargetState>(
  options: ResolveSaveTargetOptions<State>,
): Promise<ApprovedSaveTarget<State> | undefined> => {
  const targetPath = options.selectedPath.toLowerCase().endsWith(options.extension.toLowerCase())
    ? options.selectedPath
    : `${options.selectedPath}${options.extension}`;
  const state = await options.inspect(targetPath);

  if (
    targetPath !== options.selectedPath &&
    state.exists &&
    !(await options.confirmAddedExtensionOverwrite(targetPath))
  ) {
    return undefined;
  }

  return { path: targetPath, state };
};
