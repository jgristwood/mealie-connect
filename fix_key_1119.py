with open("src/App.tsx", "r+") as f:
    content = f.read()
    content = content.replace("key={${ingredient.id ?? 
ingredient}-}", "key={}`{ingredient.id ?? ingredient}-${index}`)")
    with open("src/App.tsx", "w") as f:
        f.write(content)
