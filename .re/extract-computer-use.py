import io, os, re

D = r'E:/WorkSpaces/Test09/claude-re-2.1.302/02-modules/files'
OUT = r'E:/WorkSpaces/Test09/MyClaude/_computer-use.txt'
parts = []
w = lambda s: parts.append(s)

pats = [
    r'computer[-_]?20\d{2}[a-z0-9_]*',      # tool version names like computer_20250124
    r'computer_use|computerUse|ComputerUse',
    r'"computer"',
    r'action_?[Cc]onstants|mouse_move|left_click|type_text|key_press|scroll|wait_action',
]

for f in sorted(os.listdir(D)):
    if not f.endswith('.js'):
        continue
    s = io.open(os.path.join(D, f), encoding='utf8', errors='replace').read()
    for p in pats:
        for m in list(re.finditer(p, s))[:3]:
            frag = s[max(0, m.start()-250):m.start()+500].replace('\n', ' ')
            w(f'==== {p} @ {f}:{m.start()} ====')
            w(frag[:700])
            w('')

io.open(OUT, 'w', encoding='utf8').write('\n'.join(parts))
print('written', OUT, f'{len(parts)} fragments')
