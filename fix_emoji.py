import pathlib
p = pathlib.Path('README.md')
text = p.read_text(encoding='utf-8')
text = text.replace('### ?? Built-in Addons & Indexers', '### ?? Built-in Addons & Indexers')
p.write_text(text, encoding='utf-8')
print("Emoji fixed")
