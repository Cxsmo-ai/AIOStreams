import pathlib
p = pathlib.Path('README.md')
lines = p.read_text(encoding='utf-8').splitlines()
for i, line in enumerate(lines):
    if line.startswith('#'):
        print(f"Line {i+1}: {line.encode('ascii', 'ignore').decode()}")
