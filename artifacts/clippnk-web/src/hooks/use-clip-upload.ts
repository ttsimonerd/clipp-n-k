import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListClipsQueryKey, type Clip } from '@workspace/api-client-react';

interface UploadFileOptions {
  title?: string;
  onProgress?: (percent: number) => void;
}

/**
 * Uploads a single file via XHR (for upload-progress reporting) and resolves
 * with the created clip. Rejects with a human-readable Error on failure.
 *
 * The dialog drives batches by calling this once per file (with a small
 * concurrency limit); each call is fully independent so one failure never
 * aborts the others.
 */
export function useClipUpload() {
  const [activeUploads, setActiveUploads] = useState(0);
  const queryClient = useQueryClient();

  const uploadFile = useCallback(
    ({ file, title, onProgress }: UploadFileOptions & { file: File }): Promise<Clip> =>
      new Promise<Clip>((resolve, reject) => {
        setActiveUploads((n) => n + 1);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${import.meta.env.BASE_URL}api/clips`);
        xhr.withCredentials = true;

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percentComplete = Math.round((event.loaded / event.total) * 100);
            onProgress?.(percentComplete);
          }
        };

        xhr.onload = () => {
          setActiveUploads((n) => Math.max(0, n - 1));
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const clip: Clip = JSON.parse(xhr.responseText);
              // Invalidate the clip list so the new clip appears immediately
              queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
              resolve(clip);
            } catch {
              reject(new Error('Invalid response from server'));
            }
          } else {
            let msg = 'Upload failed';
            try {
              const res = JSON.parse(xhr.responseText);
              if (res.error) msg = res.error;
            } catch {
              // ignore
            }
            reject(new Error(msg));
          }
        };

        xhr.onerror = () => {
          setActiveUploads((n) => Math.max(0, n - 1));
          reject(new Error('Network error during upload'));
        };

        xhr.onabort = () => {
          setActiveUploads((n) => Math.max(0, n - 1));
          reject(new Error('Upload cancelled'));
        };

        const formData = new FormData();
        formData.append('file', file);
        if (title) formData.append('title', title);

        xhr.send(formData);
      }),
    [queryClient],
  );

  return { uploadFile, isUploading: activeUploads > 0 };
}
