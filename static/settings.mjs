export const effortLabel = value => ({none:'无',minimal:'最少',low:'低',medium:'中',high:'高',xhigh:'更高',max:'最高',ultra:'极高'})[value] || value;
export function selectionForModel(models, model, effort) {
  const entry = models.find(item => item.id === model);
  if (!entry) return {model,effort:null,changed:false,valid:false};
  const supported = entry.efforts.some(item => item.id === effort);
  const next = supported ? effort : entry.defaultEffort;
  return {model,effort:next,changed:!supported,valid:entry.efforts.some(item => item.id === next)};
}
export function newestSettings(snapshot, live) {
  if (!snapshot) return live ?? null;
  if (!live) return snapshot;
  const [se,sr] = snapshot.version.split(':'), [le,lr] = live.version.split(':');
  return se === le && Number(lr) >= Number(sr) ? live : snapshot;
}
