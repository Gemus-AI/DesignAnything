/**
 * 这种载体走不走「文档分类」这条通道（#3680）。
 *
 * 抽成具名函数是因为**这一行本身出过错**：docx 一条分支都不匹配，于是落到最后按
 * Content-Type 的确定性归属，而那条只认 `application/pdf` 是文档 —— 成因记 `content-type`
 * （量尺的正式回答：「没有槽收这种载体」），对应的核心槽判**真缺件**。一份内容完全正确的
 * docx 因此在读数上等同于什么都没交。名单散在一个长条件里时，漏一种载体不会报错，
 * 只是那种载体的读数静默错一档。
 *
 * 进这条通道**不等于**能满足页数下限：docx 走进来之后正文进分类器，但页数仍不可知
 * （见 `artifactEvidence.readDocx`），于是落 `page-floor` / `unknown-page-count` ——
 * 那一档在 #3677 之后读作「没测出来」，而不是「没交」。
 */
export function isDocumentClassifiableCarrier(contentType: string): boolean {
  return contentType === 'application/pdf'
    || contentType === 'text/html'
    // OOXML 的两种：pptx（presentationml）与 docx（wordprocessingml）
    || contentType.includes('presentationml')
    || contentType.includes('wordprocessingml')
}
