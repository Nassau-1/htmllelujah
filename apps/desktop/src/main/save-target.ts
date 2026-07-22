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
  readonly confirmOverwrite: (targetPath: string) => Promise<boolean>;
}

/**
 * Resolves the exact path that will be written after adding a required extension.
 *
 * The post-dialog inspection is authoritative for the exact path that will be written.
 * Any file observed there requires explicit application consent: native dialog consent
 * cannot cover a file that appeared after the dialog performed its own existence check.
 */
export const resolveSaveTarget = async <State extends SaveTargetState>(
  options: ResolveSaveTargetOptions<State>,
): Promise<ApprovedSaveTarget<State> | undefined> => {
  const targetPath = options.selectedPath.toLowerCase().endsWith(options.extension.toLowerCase())
    ? options.selectedPath
    : `${options.selectedPath}${options.extension}`;
  const state = await options.inspect(targetPath);

  if (state.exists && !(await options.confirmOverwrite(targetPath))) {
    return undefined;
  }

  return { path: targetPath, state };
};
