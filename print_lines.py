import pathlib
p = pathlib.Path('README.md')
lines = p.read_text(encoding='utf-8').splitlines()
for i in range(65, min(110, len(lines))):
    print(f"{i+1}: {repr(lines[i])}")
