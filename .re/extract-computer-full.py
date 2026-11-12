import io, re

s = io.open(r'E:/WorkSpaces/Test09/claude-re-2.1.302/02-modules/files/chunk-1h2r50md.js', encoding='utf8', errors='replace').read()
out = io.open(r'E:/WorkSpaces/Test09/MyClaude/_computer-use-full.txt', 'w', encoding='utf8')

# The computer tool's full description + inputSchema starts around index 9100
i = s.find('Use a mouse and keyboard to interact with a web browser')
# walk back to the tool object start
start = s.rfind('{name:"computer"', 0, i)
if start < 0:
    start = s.rfind('name:"computer"', 0, i)
# extract a generous slice (schema is long)
frag = s[start:start+14000]
out.write('==== computer tool (full) ====\n')
out.write(frag)
out.write('\n\n==== navigate tool ====\n')
j = s.find('{name:"navigate"')
out.write(s[j:j+4000] if j >= 0 else 'NOT FOUND')
out.write('\n\n==== tabs_context_mcp ====\n')
j = s.find('tabs_context_mcp')
out.write(s[max(0,j-200):j+3000] if j >= 0 else 'NOT FOUND')
out.write('\n\n==== browser_batch ====\n')
j = s.find('browser_batch')
out.write(s[max(0,j-300):j+2500] if j >= 0 else 'NOT FOUND')
out.close()
print('done, computer tool slice from', start)
