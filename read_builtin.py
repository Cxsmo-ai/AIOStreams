import pathlib
p = pathlib.Path('README.md')
lines = p.read_text(encoding='utf-8').splitlines()
for i in range(70, min(105, len(lines))):
    print(f"{i+1}: {lines[i].encode('ascii', 'ignore').decode()}")
