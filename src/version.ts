export const getLangVersion: () => string | undefined = () => {
  if (process?.versions?.node) {
    return `node@${process.versions.node}`;
  }
//   else if (Deno?.version) {
//     return `deno@${Deno?.version?.deno}`;
//   }
};
