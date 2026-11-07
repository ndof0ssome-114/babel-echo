// Hand-authored documentation, not generated or recorded meeting content.
export const READER_EXAMPLE = `# Markdown 阅读与打印示例

这个示例展示 **表格、流程图、数学公式与代码** 的排版。它是说明文档，不是实际会议记录。

## 信息对照

| 表现方式 | 适合表达 | 注意事项 |
| :--- | :--- | :--- |
| 表格 | 多项信息比较 | 保留具体事实 |
| 流程图 | 明确的步骤与关系 | 不补充不存在的环节 |
| 数据图 | 已有的数字与比例 | 不猜测数值 |

## 步骤关系

\`\`\`mermaid
flowchart LR
  A["读取 Markdown"] --> B["本地排版"]
  B --> C["阅读与目录导航"]
  C --> D["打印或保存 PDF"]
\`\`\`

## 数据示例

以下数字仅用于展示图表：

\`\`\`mermaid
pie title 示例构成
  "阅读" : 6
  "排版" : 3
  "打印" : 1
\`\`\`

## 公式与列表

行内公式 $E = mc^2$；展示公式：

$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

- [x] 本地呈现 Markdown
- [x] 图表与表格一起打印
- [ ] 在实际打印机上检查纸张效果
  - 可以先保存 PDF 预览。

> 引用、**粗体**、*斜体*、~~删除线~~ 和脚注[^note] 均可呈现。

## 代码示例

\`\`\`javascript
const document = { format: 'Markdown', local: true };
console.log(document.format);
\`\`\`

[^note]: 阅读器不会自动访问文档中的网络图片。
`;
