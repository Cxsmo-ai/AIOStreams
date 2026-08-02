import pathlib

p = pathlib.Path('README.md')
text = p.read_text(encoding='utf-8')
start = text.find('### ?? Built-in Addons')
end = text.find('---', start)
print(text[start:end])
