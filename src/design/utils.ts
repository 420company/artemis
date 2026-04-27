// 设计系统工具
// 包含通用工具函数和辅助方法

import { DESIGN_STYLES, DesignStyle } from './styles/index.js';

// 颜色操作工具
export class ColorUtils {
  // RGB到HEX
  static rgbToHex(r: number, g: number, b: number): string {
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }
  
  // HEX到RGB
  static hexToRgb(hex: string): { r: number; g: number; b: number } {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
  }
  
  // 颜色亮度
  static getLuminance(r: number, g: number, b: number): number {
    const a = [r, g, b].map(v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
  }
  
  // 颜色对比度
  static getContrast(hex1: string, hex2: string): number {
    const rgb1 = this.hexToRgb(hex1);
    const rgb2 = this.hexToRgb(hex2);
    
    const lum1 = this.getLuminance(rgb1.r, rgb1.g, rgb1.b);
    const lum2 = this.getLuminance(rgb2.r, rgb2.g, rgb2.b);
    
    const brightest = Math.max(lum1, lum2);
    const darkest = Math.min(lum1, lum2);
    
    return (brightest + 0.05) / (darkest + 0.05);
  }
  
  // 调整颜色亮度
  static adjustBrightness(hex: string, percent: number): string {
    const rgb = this.hexToRgb(hex);
    const adjusted = {
      r: Math.max(0, Math.min(255, rgb.r + (rgb.r * percent / 100))),
      g: Math.max(0, Math.min(255, rgb.g + (rgb.g * percent / 100))),
      b: Math.max(0, Math.min(255, rgb.b + (rgb.b * percent / 100)))
    };
    return this.rgbToHex(Math.round(adjusted.r), Math.round(adjusted.g), Math.round(adjusted.b));
  }
}

// 字体操作工具
export class TypographyUtils {
  // 计算字体尺寸
  static calculateFontSizes(baseSize: number): any {
    return {
      'h1': `${baseSize * 3.0}px`,
      'h2': `${baseSize * 2.5}px`,
      'h3': `${baseSize * 2.0}px`,
      'h4': `${baseSize * 1.75}px`,
      'h5': `${baseSize * 1.5}px`,
      'h6': `${baseSize * 1.25}px`,
      'body': `${baseSize}px`,
      'small': `${baseSize * 0.875}px`
    };
  }
  
  // 字体权重映射
  static fontWeightMapping(weight: string | number): number {
    if (typeof weight === 'number') {
      return weight;
    }
    
    const weightMap: Record<string, number> = {
      'thin': 100,
      'extra-light': 200,
      'light': 300,
      'normal': 400,
      'medium': 500,
      'semi-bold': 600,
      'bold': 700,
      'extra-bold': 800,
      'black': 900
    };
    
    return weightMap[weight.toLowerCase()] || 400;
  }
}

// 布局操作工具
export class LayoutUtils {
  // 响应式断点
  static getBreakpoints(): any {
    return {
      'xs': '0px',
      'sm': '640px',
      'md': '768px',
      'lg': '1024px',
      'xl': '1280px',
      '2xl': '1536px'
    };
  }
  
  // 网格计算
  static calculateGrid(width: number, columns: number, gutter: number): any {
    const totalGutter = (columns - 1) * gutter;
    const columnWidth = (width - totalGutter) / columns;
    
    return {
      width,
      columns,
      gutter,
      columnWidth,
      totalGutter
    };
  }
}

// 设计系统验证工具
export class DesignSystemValidator {
  // 验证设计风格
  static validateDesignStyle(style: any): boolean {
    return style && style.name && style.english && style.description && style.key_elements;
  }
  
  // 验证颜色方案
  static validateColorPalette(colors: string[]): boolean {
    if (!Array.isArray(colors) || colors.length < 3) {
      return false;
    }
    
    return colors.every(color => /^#[0-9A-Fa-f]{6}$/.test(color));
  }
  
  // 验证排版方案
  static validateTypography(typography: any): boolean {
    return typography && typography.headings && typography.body && 
           typography.weight && typography.spacing && typography.lineHeight;
  }
  
  // 验证布局方案
  static validateLayout(layout: any): boolean {
    return layout && layout.grid && layout.spacing && layout.maxWidth && 
           layout.alignment && layout.negativeSpace;
  }
  
  // 验证设计方案
  static validateDesignPlan(plan: any): boolean {
    return this.validateDesignStyle(plan.style) &&
           this.validateColorPalette(plan.colors.palette) &&
           this.validateTypography(plan.typography) &&
           this.validateLayout(plan.layout);
  }
}

// 设计系统优化工具
export class DesignSystemOptimizer {
  // 优化颜色方案对比度
  static optimizeColorContrast(palette: string[]): string[] {
    return palette.map((color, index) => {
      return color;
    });
  }
  
  // 优化字体层次
  static optimizeTypographyHierarchy(typography: any): any {
    const weights = typography.weight.map((weight: string | number) => 
      TypographyUtils.fontWeightMapping(weight)
    ).sort((a: number, b: number) => a - b);
    
    return {
      ...typography,
      weight: weights
    };
  }
  
  // 优化响应式布局
  static optimizeResponsiveLayout(layout: any): any {
    const breakpoints = LayoutUtils.getBreakpoints();
    
    return {
      ...layout,
      responsive: Object.keys(breakpoints).map(breakpoint => ({
        breakpoint,
        ...layout
      }))
    };
  }
}
