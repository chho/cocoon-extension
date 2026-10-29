function createHeader(document: Document) {
  const header = document.createElement("div");
  header.className = "cocoon-tag-drawer-header";
  const title = document.createElement("span");
  title.className = "cocoon-tag-drawer-title";
  title.textContent = "标签";
  title.setAttribute("role", "status");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "cocoon-tag-drawer-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "取消并关闭标签选择");
  header.append(title, close);
  return { header, title, close };
}

function createNewTagForm(document: Document) {
  const form = document.createElement("form");
  form.className = "cocoon-tag-form";
  const label = document.createElement("label");
  label.className = "cocoon-visually-hidden";
  label.htmlFor = "cocoon-new-tag-input";
  label.textContent = "新标签名称";
  const input = document.createElement("input");
  input.id = "cocoon-new-tag-input";
  input.className = "cocoon-tag-input";
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = "新标签，按 Enter";
  input.setAttribute("aria-label", "新标签名称，按 Enter 创建并屏蔽作者");
  form.append(label, input);
  return { form, input };
}

function pendingRenderer(drawer: HTMLElement, controls: HTMLFieldSetElement, title: HTMLElement) {
  let savedStyle: string | null = null;
  return (pending: boolean): void => {
    if (pending && savedStyle === null) {
      const bounds = drawer.getBoundingClientRect();
      savedStyle = drawer.style.cssText;
      // Freeze the painted footprint even if submission interrupts the opening animation.
      Object.assign(drawer.style, {
        left: `${bounds.left}px`,
        top: `${bounds.top}px`,
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
        transform: "none",
        transition: "none",
        opacity: "1",
      });
    } else if (!pending && savedStyle !== null) {
      drawer.style.cssText = savedStyle;
      savedStyle = null;
    }
    controls.disabled = pending;
    drawer.setAttribute("aria-busy", String(pending));
    title.textContent = pending ? "处理中…" : "标签";
  };
}

export function createDrawerView(document: Document, remoteOptions: HTMLElement) {
  const drawer = document.createElement("aside");
  drawer.className = "cocoon-tag-drawer";
  drawer.hidden = true;
  drawer.inert = true;
  drawer.dataset.phase = "hidden";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-hidden", "true");
  drawer.setAttribute("aria-label", "选择作者标签并屏蔽");
  const { header, title, close } = createHeader(document);
  const tagList = document.createElement("div");
  tagList.className = "cocoon-tag-list";
  tagList.setAttribute("aria-label", "已有标签");
  const { form, input } = createNewTagForm(document);
  const controls = document.createElement("fieldset");
  controls.className = "cocoon-tag-controls";
  controls.setAttribute("aria-label", "作者屏蔽设置");
  controls.append(header, tagList, form, remoteOptions);
  drawer.append(controls);
  document.body.append(drawer);
  return {
    drawer,
    drawerCloseButton: close,
    tagList,
    newTagForm: form,
    newTagInput: input,
    setSubmitting: pendingRenderer(drawer, controls, title),
  };
}
