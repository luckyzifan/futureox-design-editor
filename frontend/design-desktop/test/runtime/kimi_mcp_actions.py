"""Call packaged Futureox MCP tools through the client bundled with Kimi CLI.

This is the same fastmcp client that `kimi-cli mcp test` uses. It is not a
model session. The config path is a private temporary mcp.json; the bridge
token and socket are passed to the packaged adapter as the ordinary stdio
environment and are not printed.
"""
import asyncio
import json
import sys
import uuid

import fastmcp


def structured(result):
    value = getattr(result, "structured_content", None)
    if isinstance(value, dict):
        return value
    data = getattr(result, "data", None)
    return data if isinstance(data, dict) else {}


def is_error(result):
    return bool(getattr(result, "is_error", False))


async def main(config_path):
    with open(config_path, encoding="utf-8") as handle:
        config = json.load(handle)
    server = config["mcpServers"]["futureox_design"]
    summary = {"read": False, "edit": False, "screenshot": False, "undo": False}
    async with fastmcp.Client({"mcpServers": {"futureox_design": server}}) as client:
        tools = {tool.name for tool in await client.list_tools()}
        for required in ("design_document_get", "design_batch_apply", "design_node_get", "design_preview_capture", "design_history_undo"):
            if required not in tools:
                raise RuntimeError(f"packaged tool is missing: {required}")
        document = structured(await client.call_tool("design_document_get", {"params": {}}))
        if not document.get("documentId"):
            raise RuntimeError("design_document_get returned no document")
        summary["read"] = True
        async def current_fence():
            current = structured(await client.call_tool("design_document_get", {"params": {}}))
            return {
                "documentId": current["documentId"],
                "session": current["session"],
                "expectedRevision": current["revision"],
            }

        node_id = str(uuid.uuid4())
        created = await client.call_tool("design_batch_apply", {
            "params": {"operations": [{
                "method": "node.create",
                "params": {
                    "id": node_id,
                    "kind": "rectangle",
                    "width": 120,
                    "height": 40,
                    "patch": {"name": "External Kimi card"},
                },
            }]},
            **(await current_fence()),
        })
        if is_error(created):
            raise RuntimeError("design_batch_apply failed")
        node = structured(await client.call_tool("design_node_get", {"params": {"id": node_id}}))
        name = ((node.get("result") or {}).get("node") or {}).get("name")
        if name != "External Kimi card":
            raise RuntimeError(f"created node is not readable: {name}")
        summary["edit"] = True
        capture = await client.call_tool("design_preview_capture", {
            "params": {"nodeIds": [node_id], "format": "png"},
            **(await current_fence()),
        })
        image = next((item for item in (getattr(capture, "content", None) or []) if getattr(item, "type", None) == "image"), None)
        if image is None or not getattr(image, "data", "").startswith("iVBOR"):
            raise RuntimeError("design_preview_capture did not return PNG bytes")
        summary["screenshot"] = True
        moved = await client.call_tool("design_batch_apply", {
            "params": {"operations": [{
                "method": "node.update",
                "params": {"ids": [node_id], "patch": {"transform": [1, 0, 0, 1, 100, 200]}},
            }]},
            **(await current_fence()),
        })
        if is_error(moved):
            raise RuntimeError("moving the node failed")
        positioned = structured(await client.call_tool("design_node_get", {"params": {"id": node_id}}))
        transform = ((positioned.get("result") or {}).get("node") or {}).get("transform") or []
        if len(transform) < 6 or transform[4] != 100 or transform[5] != 200:
            raise RuntimeError("node move was not applied")
        undone = await client.call_tool("design_history_undo", {"params": {}, **(await current_fence())})
        if is_error(undone):
            raise RuntimeError("design_history_undo failed")
        after = structured(await client.call_tool("design_node_get", {"params": {"id": node_id}}))
        restored = ((after.get("result") or {}).get("node") or {}).get("transform") or []
        if len(restored) < 6 or restored[4] != 0 or restored[5] != 0:
            raise RuntimeError("undo did not restore the node transform")
        summary["undo"] = True
    print(json.dumps(summary))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))