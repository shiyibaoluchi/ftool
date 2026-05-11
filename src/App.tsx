import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import { listen } from "@tauri-apps/api/event";

interface ProcessResult {
  success_count: number;
  fail_count: number;
  messages: string[];
}

interface DirEntry {
  name: string;
  is_dir: boolean;
}

function App() {
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [suffix, setSuffix] = useState<string>("xml");
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const addLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${timestamp}] ${msg}`]);
  };

  // 监听 Tauri 文件拖拽事件
  useEffect(() => {
    const setupListeners = async () => {
      const unlistenDrop = await listen<string[]>("tauri://file-drop", (event) => {
        const paths = event.payload;
        handleSelectedPaths(paths);
        setIsDragOver(false);
      });

      const unlistenHover = await listen("tauri://file-drop-hover", () => {
        setIsDragOver(true);
      });

      const unlistenCancel = await listen("tauri://file-drop-cancelled", () => {
        setIsDragOver(false);
      });

      return () => {
        unlistenDrop();
        unlistenHover();
        unlistenCancel();
      };
    };

    const cleanup = setupListeners();
    return () => { cleanup.then(fn => fn()); };
  }, []);

  // 监听实时日志事件
  useEffect(() => {
    const setupLogListener = async () => {
      const unlisten = await listen<string>("process-log", (event) => {
        const timestamp = new Date().toLocaleTimeString();
        setLogs((prev) => [...prev, `[${timestamp}] ${event.payload}`]);
      });
      return () => { unlisten(); };
    };

    const cleanup = setupLogListener();
    return () => { cleanup.then(fn => fn()); };
  }, []);

  // 自动滚动日志到底部
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  const handleSelectedPaths = async (paths: string[]) => {
    if (paths.length === 0) return;

    setSelectedPaths(paths);
    setResult(null);

    addLog(`已选择 ${paths.length} 个路径`);
    for (const p of paths) {
      addLog(`  ${p}`);
    }

    // 如果只有一个路径且是目录，预览内容
    if (paths.length === 1) {
      const p = paths[0];
      try {
        const dirEntries = await invoke<DirEntry[]>("read_directory", {
          path: p,
        });
        setEntries(dirEntries);
      } catch {
        // 不是目录或无法读取，忽略预览
        setEntries([]);
      }
    } else {
      setEntries([]);
    }
  };

  // 选择文件夹
  const selectDirectory = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: true,
        title: "选择文件夹",
      });
      if (selected) {
        await handleSelectedPaths([selected as string]);
      }
    } catch (e) {
      addLog(`选择文件夹失败: ${e}`);
    }
  };

  // 选择文件（多选）
  const selectFiles = async () => {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        title: "选择文件（将执行触控操作）",
        filters: [{ name: "所有文件", extensions: ["*"] }],
      });
      if (selected) {
        const files = selected as string[];
        await handleSelectedPaths(files);
      }
    } catch (e) {
      addLog(`选择文件失败: ${e}`);
    }
  };

  // 开始处理
  const handleTouch = async () => {
    if (selectedPaths.length === 0) return;
    if (!suffix.trim()) {
      addLog("错误: 后缀不能为空");
      return;
    }

    const ext = suffix.trim();

    setIsProcessing(true);
    setResult(null);
    setLogs([]);
    setShowLogs(true);

    addLog("=".repeat(40));
    addLog(`开始 touch 操作：添加 .${ext} 后缀 → 移除 .${ext} 后缀`);
    addLog(`处理 ${selectedPaths.length} 个路径`);
    addLog("=".repeat(40));

    try {
      const res = await invoke<ProcessResult>("touch_files", {
        paths: selectedPaths,
        suffix: ext,
      });
      setResult(res);
      addLog("=".repeat(40));
      addLog(`处理完成: 成功 ${res.success_count} 个, 失败 ${res.fail_count} 个`);

      // 刷新目录预览
      if (selectedPaths.length === 1) {
        try {
          const dirEntries = await invoke<DirEntry[]>("read_directory", {
            path: selectedPaths[0],
          });
          setEntries(dirEntries);
        } catch {
          setEntries([]);
        }
      }
    } catch (e) {
      addLog(`处理失败: ${e}`);
      setResult({
        success_count: 0,
        fail_count: 1,
        messages: [`处理失败: ${e}`],
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const toggleLogs = () => {
    setShowLogs(!showLogs);
  };

  const isDirSelected =
    selectedPaths.length === 1 &&
    entries.length > 0;

  return (
    <div className="app-container">
      <div className="app-header">
        <h1 className="app-title">ftool</h1>
        <p className="app-subtitle">文件触控处理工具</p>
      </div>

      {/* 选择按钮 */}
      <div className="buttons-container">
        <button
          className="btn btn-primary"
          onClick={selectDirectory}
          disabled={isProcessing}
        >
          📂 选择文件夹
        </button>
        <button
          className="btn btn-primary"
          onClick={selectFiles}
          disabled={isProcessing}
        >
          📄 选择文件
        </button>
      </div>

      {/* 拖拽区域 */}
      <div
        className={`drop-zone ${isDragOver ? "active" : ""}`}
      >
        <div className="drop-zone-icon">
          {isDragOver ? "📂" : "📁"}
        </div>
        <div className="drop-zone-text">
          {isDragOver
            ? "松开鼠标 - 立即处理"
            : "将文件或文件夹拖入此处"}
        </div>
        <div className="drop-zone-hint">
          支持拖入文件或文件夹
        </div>
      </div>

      {/* 后缀输入 */}
      <div className="suffix-container">
        <label className="suffix-label">后缀名：</label>
        <input
          type="text"
          className="suffix-input"
          value={suffix}
          onChange={(e) => setSuffix(e.target.value)}
          placeholder="输入后缀，如 xml"
          disabled={isProcessing}
        />
      </div>

      {/* 选中路径显示 */}
      {selectedPaths.length > 0 && (
        <div className="selected-path">
          {selectedPaths.length === 1
            ? selectedPaths[0]
            : `已选择 ${selectedPaths.length} 个文件`}
        </div>
      )}

      {/* 目录预览 */}
      {isDirSelected && (
        <div className="preview-container">
          <div className="preview-header">
            📁 目录预览 ({entries.length} 个项目)
          </div>
          <div className="preview-list">
            {entries.slice(0, 50).map((entry, i) => (
              <div
                key={i}
                className={`preview-item ${entry.is_dir ? "folder" : "file"}`}
              >
                {entry.is_dir ? "📁" : "📄"} {entry.name}
              </div>
            ))}
            {entries.length > 50 && (
              <div className="preview-more">
                ... 还有 {entries.length - 50} 项
              </div>
            )}
          </div>
        </div>
      )}

      {/* 操作说明 */}
      <div className="action-info">
        <span className="action-badge">操作流程</span>
        <span className="action-text">
          每个文件执行: 添加 .{suffix} 后缀 → 移除 .{suffix} 后缀（触控操作，刷新文件元数据）
        </span>
      </div>

      {/* 开始处理按钮 */}
      <button
        className="btn btn-action"
        onClick={handleTouch}
        disabled={selectedPaths.length === 0 || isProcessing}
      >
        {isProcessing ? "⏳ 处理中..." : "🚀 开始处理"}
      </button>

      {/* 加载动画 */}
      {isProcessing && (
        <div className="loading">
          <div className="loading-spinner"></div>
          <div className="loading-text">正在处理文件，请稍候...</div>
        </div>
      )}

      {/* 日志区域 */}
      <div className="buttons-container" style={{ marginTop: 16 }}>
        <button className="btn btn-log" onClick={toggleLogs}>
          📋 {showLogs ? "隐藏日志" : "显示日志"}
        </button>
      </div>

      {showLogs && logs.length > 0 && (
        <div className="logs-container">
          <div className="logs-header">执行日志</div>
          <div className="logs-list">
            {logs.map((log, i) => (
              <div key={i} className="log-item">
                {log}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}

      {/* 结果 */}
      {result && !isProcessing && (
        <div className="results-container">
          <div className="results-header">
            <h3 className="results-title">处理结果</h3>
            <div className="results-summary">
              <span className="result-stat success">
                ✅ 成功: {result.success_count}
              </span>
              {result.fail_count > 0 && (
                <span className="result-stat fail">
                  ❌ 失败: {result.fail_count}
                </span>
              )}
            </div>
          </div>
          <div className="results-list">
            {result.messages.map((msg, i) => (
              <div
                key={i}
                className={`result-item ${
                  msg.startsWith("[失败]") || msg.startsWith("[警告]")
                    ? "fail"
                    : msg.startsWith("[跳过]")
                    ? "skip"
                    : "success"
                }`}
              >
                {msg}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
